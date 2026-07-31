import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type A1SafeId,
  type CollaborationServerId,
  type DispatchAuthorization,
  type NativeBindingId,
  type NativeDeliveryAttemptId,
  type NativeRuntimeId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseDispatchAuthorization,
} from "./ids.js";
import {
  type ArmDispatchRequest,
  type ArmDispatchResult,
  type ConsumeDispatchRequest,
  type ConsumeDispatchResult,
  PROTECTED_HANDLE_KINDS,
  PROTECTED_SCOPE_KINDS,
  ProtectedByteSnapshot,
  type ProtectedDispatchOperations,
  type ProtectedHandleOperations,
  type ProtectedHandleRef,
  type ProtectedOperationScope,
  type PutArtifactRequest,
  parseProtectedHandleRef,
  parseProtectedOperationScope,
  type ReadVerifiedArtifactResult,
  type RevokeDispatchRequest,
  type RevokeDispatchResult,
  type SignReservedResult,
} from "./protected.js";

function encoded(bytes: number, fill = 0): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

function protectedHandleId(fill = 1) {
  return parseA1CanonicalId("protectedHandle", `rcph_${encoded(16, fill)}`);
}

describe("protected handle references", () => {
  it("accepts only the selected five kinds and exact reference fields", () => {
    expect(Object.isFrozen(PROTECTED_HANDLE_KINDS)).toBe(true);
    expect(PROTECTED_HANDLE_KINDS).toEqual([
      "artifact",
      "signing_key",
      "provider_credential",
      "callable_port",
      "dispatch_authorization",
    ]);

    for (const kind of PROTECTED_HANDLE_KINDS) {
      const value = {
        protectedHandleId: protectedHandleId(PROTECTED_HANDLE_KINDS.indexOf(kind) + 1),
        kind,
      };
      const parsed = parseProtectedHandleRef(value);
      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  it("rejects missing, extra, inherited, malformed, and cross-namespace values", () => {
    const valid = {
      protectedHandleId: protectedHandleId(),
      kind: "artifact",
    };
    expect(() => parseProtectedHandleRef({ ...valid, extra: true })).toThrow(
      /exactly the selected fields/,
    );
    expect(() => parseProtectedHandleRef({ kind: "artifact" })).toThrow(
      /exactly the selected fields/,
    );
    expect(() => parseProtectedHandleRef(["artifact", protectedHandleId()])).toThrow(
      /must be an object/,
    );
    expect(() =>
      parseProtectedHandleRef(Object.create({ protectedHandleId: protectedHandleId() })),
    ).toThrow(/plain object/);
    expect(() => parseProtectedHandleRef({ ...valid, kind: "credential" })).toThrow(
      /not a selected value/,
    );
    expect(() =>
      parseProtectedHandleRef({
        ...valid,
        protectedHandleId: `rcl_${encoded(16)}`,
      }),
    ).toThrow(/rcph_/);
  });

  it("keeps the one-use secret separate from its rcph_ reference", () => {
    const secret = parseDispatchAuthorization(encoded(32, 9));
    const ref = parseProtectedHandleRef({
      protectedHandleId: protectedHandleId(9),
      kind: "dispatch_authorization",
    });

    expect(ref.protectedHandleId).not.toBe(secret);
    expectTypeOf(secret).toEqualTypeOf<DispatchAuthorization>();
    if (ref.kind !== "dispatch_authorization") {
      throw new Error("unexpected protected handle kind");
    }
    expectTypeOf(ref).toMatchTypeOf<ProtectedHandleRef<"dispatch_authorization">>();
    expect(() =>
      parseProtectedHandleRef({
        protectedHandleId: secret,
        kind: "dispatch_authorization",
      }),
    ).toThrow(/rcph_/);
  });

  it("does not copy rejected authorization material into validation errors", () => {
    const secret = encoded(32, 11);
    let error: unknown;
    try {
      parseProtectedHandleRef({
        protectedHandleId: protectedHandleId(),
        kind: "dispatch_authorization",
        dispatchAuthorization: secret,
      });
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).toContain("protectedHandleRef");
    expect(String(error)).not.toContain(secret);
  });
});

describe("protected operation surface", () => {
  it("snapshots genuine byte views without retaining source or returned-copy aliases", () => {
    const ordinary = Uint8Array.of(1, 2);
    const buffer = Buffer.from([3, 4]);
    const sharedBacking = new SharedArrayBuffer(2);
    const shared = new Uint8Array(sharedBacking);
    shared.set([5, 6]);

    const cases = [
      { source: ordinary, expected: [1, 2] },
      { source: buffer, expected: [3, 4] },
      { source: shared, expected: [5, 6] },
    ] as const;

    for (const { source, expected } of cases) {
      const snapshot = ProtectedByteSnapshot.from(source);
      source.fill(0xff);

      const first = snapshot.copyBytes();
      expect(first).toEqual(Uint8Array.from(expected));
      expect(first.buffer).toBeInstanceOf(ArrayBuffer);
      expect((first.buffer as ArrayBuffer & { readonly resizable: boolean }).resizable).toBe(false);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(snapshot.byteLength).toBe(expected.length);

      first.fill(0);
      const second = snapshot.copyBytes();
      expect(second).not.toBe(first);
      expect(second.buffer).not.toBe(first.buffer);
      expect(second).toEqual(Uint8Array.from(expected));
    }
  });

  it("does not retain a growable SharedArrayBuffer view or observe later growth", () => {
    const backing = Reflect.construct(SharedArrayBuffer, [
      1,
      { maxByteLength: 3 },
    ]) as SharedArrayBuffer & {
      grow(newByteLength: number): void;
    };
    const source = new Uint8Array(backing);
    source[0] = 0xaa;

    const snapshot = ProtectedByteSnapshot.from(source);
    backing.grow(3);
    new Uint8Array(backing).set([0xbb, 0xcc, 0xdd]);

    expect(source.length).toBe(3);
    expect(snapshot.byteLength).toBe(1);
    expect(snapshot.copyBytes()).toEqual(Uint8Array.of(0xaa));
  });

  it("rejects byte-view impostors and makes protected byte fields nominal", () => {
    for (const value of [
      new Uint16Array([1]),
      new DataView(new ArrayBuffer(1)),
      Object.create(Uint8Array.prototype),
    ]) {
      expect(() => ProtectedByteSnapshot.from(value as Uint8Array)).toThrow(/expected Uint8Array/);
    }

    expectTypeOf<PutArtifactRequest["artifactBytes"]>().toEqualTypeOf<ProtectedByteSnapshot>();
    expectTypeOf<
      ReadVerifiedArtifactResult["artifactBytes"]
    >().toEqualTypeOf<ProtectedByteSnapshot>();
    expectTypeOf<SignReservedResult["signature"]>().toEqualTypeOf<ProtectedByteSnapshot>();
    expectTypeOf<Uint8Array extends ProtectedByteSnapshot ? true : false>().toEqualTypeOf<false>();
  });

  it("uses only the selected immutable operation scopes", () => {
    expect(Object.isFrozen(PROTECTED_SCOPE_KINDS)).toBe(true);
    expect(PROTECTED_SCOPE_KINDS).toEqual([
      "host_profile",
      "collaboration_server",
      "runtime",
      "native_binding",
      "native_attempt",
    ]);

    expectTypeOf<
      Extract<ProtectedOperationScope, { scopeKind: "host_profile" }>["scopeId"]
    >().toEqualTypeOf<"default">();
    expectTypeOf<
      Extract<ProtectedOperationScope, { scopeKind: "collaboration_server" }>["scopeId"]
    >().toEqualTypeOf<CollaborationServerId>();
    expectTypeOf<
      Extract<ProtectedOperationScope, { scopeKind: "runtime" }>["scopeId"]
    >().toEqualTypeOf<NativeRuntimeId>();
    expectTypeOf<
      Extract<ProtectedOperationScope, { scopeKind: "native_binding" }>["scopeId"]
    >().toEqualTypeOf<NativeBindingId>();
    expectTypeOf<
      Extract<ProtectedOperationScope, { scopeKind: "native_attempt" }>["scopeId"]
    >().toEqualTypeOf<NativeDeliveryAttemptId>();

    expectTypeOf<
      "other" extends ProtectedOperationScope<"host_profile">["scopeId"] ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      NativeBindingId extends ProtectedOperationScope<"collaboration_server">["scopeId"]
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      CollaborationServerId extends ProtectedOperationScope<"native_binding">["scopeId"]
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      A1SafeId extends ProtectedOperationScope<"native_attempt">["scopeId"] ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      NativeBindingId extends ProtectedOperationScope<"runtime">["scopeId"] ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      CollaborationServerId extends ProtectedOperationScope<"runtime">["scopeId"] ? true : false
    >().toEqualTypeOf<false>();

    const runtimeId = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 8)}`);
    expect(parseProtectedOperationScope("runtime", runtimeId)).toEqual({
      scopeKind: "runtime",
      scopeId: runtimeId,
    });
    expect(() => parseProtectedOperationScope("runtime", protectedHandleId())).toThrow(/rcrt_/);
    expect(() => parseProtectedOperationScope("native_binding", runtimeId)).toThrow(/rcnb_/);
    expect(() => parseProtectedOperationScope("host_profile", "other")).toThrow(/default/);
  });

  it("contains only the selected operation-specific capabilities", () => {
    const surface = {
      putArtifact: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      readVerifiedArtifact: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      signReserved: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      invokePort: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      armDispatch: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      consumeDispatch: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      revokeDispatch: vi.fn(async () => {
        throw new Error("not implemented");
      }),
    } satisfies ProtectedHandleOperations;

    expect(Object.keys(surface).sort()).toEqual([
      "armDispatch",
      "consumeDispatch",
      "invokePort",
      "putArtifact",
      "readVerifiedArtifact",
      "revokeDispatch",
      "signReserved",
    ]);
    for (const forbidden of ["resolve", "get", "read", "list", "export"]) {
      expect(forbidden in surface).toBe(false);
    }

    expectTypeOf<keyof ProtectedHandleOperations>().toEqualTypeOf<
      | "putArtifact"
      | "readVerifiedArtifact"
      | "signReserved"
      | "invokePort"
      | "armDispatch"
      | "consumeDispatch"
      | "revokeDispatch"
    >();
  });

  it("types dispatch authorization as a one-time armed transition", () => {
    expectTypeOf<ArmDispatchResult["state"]>().toEqualTypeOf<"armed">();
    expectTypeOf<
      "dispatchAuthorizationHandle" extends keyof ArmDispatchResult ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<ArmDispatchRequest["scopeKind"]>().toEqualTypeOf<"native_attempt">();
    expectTypeOf<ArmDispatchRequest["scopeId"]>().toEqualTypeOf<NativeDeliveryAttemptId>();
    expectTypeOf<
      "nativeDeliveryAttemptId" extends keyof ArmDispatchRequest ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "canonicalDispatchDigest" extends keyof ArmDispatchRequest ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<ArmDispatchResult["canonicalDispatchDigest"]>().toEqualTypeOf<
      ReturnType<typeof parseA1Digest>
    >();
    expectTypeOf<ConsumeDispatchRequest["expectedState"]>().toEqualTypeOf<"armed">();
    expectTypeOf<ConsumeDispatchResult["state"]>().toEqualTypeOf<"consumed">();
    expectTypeOf<
      ConsumeDispatchResult["dispatchAuthorizationHandle"]
    >().toEqualTypeOf<DispatchAuthorization>();
    expectTypeOf<RevokeDispatchRequest["expectedState"]>().toEqualTypeOf<"armed">();
    expectTypeOf<RevokeDispatchResult["state"]>().toEqualTypeOf<"revoked">();
    expectTypeOf<
      "dispatchAuthorizationHandle" extends keyof RevokeDispatchResult ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "dispatchAuthorization" extends keyof ArmDispatchResult ? true : false
    >().toEqualTypeOf<false>();

    expectTypeOf<
      Parameters<ProtectedDispatchOperations["consumeDispatch"]>[0]
    >().toEqualTypeOf<ConsumeDispatchRequest>();
  });

  it("binds a dispatch transition to exact scope, fence, attempt, and digests", () => {
    const nativeDeliveryAttemptId = parseA1CanonicalId(
      "nativeDeliveryAttempt",
      `nat_${encoded(32, 3)}`,
    );
    const request: ConsumeDispatchRequest = {
      scopeKind: "native_attempt",
      scopeId: nativeDeliveryAttemptId,
      fence: {
        collaborationServerId: parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`),
        coordinatorLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 2)}`),
        coordinatorEpoch: 3,
      },
      nativeClientIngressLeaseId: parseA1SafeId("ingress-lease-1"),
      canonicalDispatchDigest: parseA1Digest(encoded(32, 4)),
      nativeTargetPathDigest: parseA1Digest(encoded(32, 5)),
      canonicalRequestDigest: parseA1Digest(encoded(32, 6)),
      nativeRequestTranslationDigest: parseA1Digest(encoded(32, 7)),
      dispatchAuthorizationRef: {
        protectedHandleId: protectedHandleId(8),
        kind: "dispatch_authorization",
      },
      expectedState: "armed",
    };

    expect(request).toMatchObject({
      scopeKind: "native_attempt",
      scopeId: nativeDeliveryAttemptId,
      expectedState: "armed",
    });

    const replacementCoordinatorRequest: ConsumeDispatchRequest = {
      ...request,
      fence: {
        ...request.fence,
        coordinatorLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 9)}`),
        coordinatorEpoch: 4,
      },
    };
    expect(replacementCoordinatorRequest).toMatchObject({
      scopeId: nativeDeliveryAttemptId,
      canonicalDispatchDigest: request.canonicalDispatchDigest,
      expectedState: "armed",
      fence: { coordinatorEpoch: 4 },
    });
  });
});
