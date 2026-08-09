import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "../state/ids.js";
import {
  type RuntimeOwnerCallablePortRegistration,
  RuntimeOwnerCallablePortRegistry,
  RuntimeOwnerCallablePortRegistryError,
} from "./port-registry.js";
import type { RuntimeOwnerRpcPortInvocation } from "./protocol.js";

function bytes(length: number, fill: number): string {
  return base64urlEncode(new Uint8Array(length).fill(fill));
}

function binding(fill: number) {
  return parseA1CanonicalId("nativeBinding", `rcnb_${bytes(16, fill)}`);
}

function runtime(fill: number) {
  return parseA1CanonicalId("nativeRuntime", `rcrt_${bytes(32, fill)}`);
}

function registration(
  overrides: Partial<RuntimeOwnerCallablePortRegistration> = {},
): RuntimeOwnerCallablePortRegistration {
  const collaborationServerId = parseA1CanonicalId("collaborationServer", `rcs_${bytes(16, 1)}`);
  return {
    connectionId: bytes(16, 2),
    collaborationServerId,
    nativeBindingId: binding(3),
    runtimeId: runtime(4),
    nativeIncarnation: 1,
    attachmentLeaseId: parseA1SafeId("attachment-1"),
    ownerFence: {
      runtimeOwnerServiceLeaseId: parseA1SafeId("owner-lease-1"),
      runtimeOwnerServiceEpoch: 1,
      ownerInstanceId: parseA1SafeId("owner-1"),
      ownerProcessStartIdentitySchemaId: "remote-claw/test-owner-start/v1",
      ownerProcessStartIdentityRef: parseA1SafeId("owner-start-1"),
      ownerProcessStartIdentityDigest: parseA1Digest(bytes(32, 5)),
    },
    coordinatorFence: {
      collaborationServerId,
      coordinatorLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${bytes(16, 6)}`),
      coordinatorEpoch: 1,
    },
    portGeneration: 1,
    ...overrides,
  };
}

function invocation(
  entry: ReturnType<RuntimeOwnerCallablePortRegistry["register"]>,
): RuntimeOwnerRpcPortInvocation {
  return {
    connectionId: entry.connectionId,
    ownerFence: entry.ownerFence,
    nativeIncarnation: entry.nativeIncarnation,
    attachmentLeaseId: entry.attachmentLeaseId,
    portGeneration: entry.portGeneration,
    request: {
      scopeKind: "native_binding",
      scopeId: entry.nativeBindingId,
      callablePortRef: entry.callablePortRef,
      providerCredential: null,
      nativeBindingId: entry.nativeBindingId,
      runtimeId: entry.runtimeId,
      fence: entry.coordinatorFence,
      operationSchemaId: "remote-claw/test-port-operation/v1",
      operationRef: parseA1SafeId("port-operation-1"),
      operationDigest: parseA1Digest(bytes(32, 7)),
    },
  };
}

describe("runtime-owner callable port registry", () => {
  it("binds and authorizes the complete immutable port tuple", () => {
    const registry = new RuntimeOwnerCallablePortRegistry({
      randomBytes: () => new Uint8Array(16).fill(8),
    });
    const entry = registry.register(registration());
    const call = invocation(entry);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.callablePortRef)).toBe(true);
    expect(entry.callablePortRef).toEqual({
      protectedHandleId: `rcph_${bytes(16, 8)}`,
      kind: "callable_port",
    });
    expect(registry.authorize(call)).toBe(entry);
    expect(Object.keys(entry).sort()).toEqual(
      [
        "attachmentLeaseId",
        "callablePortRef",
        "collaborationServerId",
        "connectionId",
        "coordinatorFence",
        "nativeBindingId",
        "nativeIncarnation",
        "ownerFence",
        "portGeneration",
        "runtimeId",
      ].sort(),
    );

    const mismatches: RuntimeOwnerRpcPortInvocation[] = [
      { ...call, connectionId: bytes(16, 9) },
      { ...call, nativeIncarnation: 2 },
      { ...call, attachmentLeaseId: parseA1SafeId("attachment-2") },
      { ...call, portGeneration: 2 },
      { ...call, ownerFence: { ...call.ownerFence, runtimeOwnerServiceEpoch: 2 } },
      { ...call, request: { ...call.request, nativeBindingId: binding(10) } },
      { ...call, request: { ...call.request, runtimeId: runtime(11) } },
      {
        ...call,
        request: {
          ...call.request,
          fence: { ...call.request.fence, coordinatorEpoch: 2 },
        },
      },
    ];
    for (const changed of mismatches) {
      expect(() => registry.authorize(changed)).toThrow(RuntimeOwnerCallablePortRegistryError);
    }
  });

  it("bounds ports, rejects binding aliases, and drops a connection atomically", () => {
    let entropy = 20;
    const registry = new RuntimeOwnerCallablePortRegistry({
      maxPorts: 2,
      maxPortsPerConnection: 2,
      randomBytes: () => new Uint8Array(16).fill(entropy++),
    });
    const first = registry.register(registration());
    expect(() => registry.register(registration())).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    const second = registry.register(
      registration({ nativeBindingId: binding(12), portGeneration: 2 }),
    );
    expect(registry.size).toBe(2);
    expect(() =>
      registry.register(registration({ nativeBindingId: binding(13), portGeneration: 3 })),
    ).toThrowError(expect.objectContaining({ code: "LIMIT" }));

    expect(() => registry.unregister(bytes(16, 14), first.callablePortRef)).toThrowError(
      expect.objectContaining({ code: "MISMATCH" }),
    );
    expect(registry.unregister(first.connectionId, first.callablePortRef)).toBe(true);
    expect(registry.unregister(first.connectionId, first.callablePortRef)).toBe(false);
    expect(registry.dropConnection(second.connectionId)).toBe(1);
    expect(registry.size).toBe(0);
    expect(() => registry.authorize(invocation(second))).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("fails closed after bounded protected-handle collisions", () => {
    const registry = new RuntimeOwnerCallablePortRegistry({
      randomBytes: () => new Uint8Array(16).fill(15),
    });
    registry.register(registration());
    expect(() =>
      registry.register(
        registration({
          connectionId: bytes(16, 16),
          nativeBindingId: binding(17),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "UNAVAILABLE" }));
  });
});
