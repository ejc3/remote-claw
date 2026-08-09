import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  decodeRuntimeOwnerRpcCanonicalJson,
  encodeRuntimeOwnerRpcCanonicalJson,
  encodeRuntimeOwnerRpcFrame,
  parseRuntimeOwnerRpcPortRequest,
  parseRuntimeOwnerRpcPortResponse,
  parseRuntimeOwnerRpcReverseRequestId,
  RUNTIME_OWNER_RPC_MAX_FRAME_BYTES,
  RUNTIME_OWNER_RPC_VERSION,
  RuntimeOwnerRpcError,
  RuntimeOwnerRpcFrameDecoder,
  runtimeOwnerRpcReverseRequestId,
} from "./protocol.js";

function bytes(length: number, fill: number): string {
  return base64urlEncode(new Uint8Array(length).fill(fill));
}

function portInvocation() {
  const collaborationServerId = `rcs_${bytes(16, 1)}`;
  const nativeBindingId = `rcnb_${bytes(16, 2)}`;
  return {
    connectionId: bytes(16, 3),
    ownerFence: {
      runtimeOwnerServiceLeaseId: "owner-lease-1",
      runtimeOwnerServiceEpoch: 1,
      ownerInstanceId: "owner-1",
      ownerProcessStartIdentitySchemaId: "remote-claw/test-owner-start/v1",
      ownerProcessStartIdentityRef: "owner-start-1",
      ownerProcessStartIdentityDigest: bytes(32, 4),
    },
    nativeIncarnation: 1,
    attachmentLeaseId: "attachment-1",
    portGeneration: 1,
    request: {
      scopeKind: "native_binding",
      scopeId: nativeBindingId,
      callablePortRef: {
        protectedHandleId: `rcph_${bytes(16, 5)}`,
        kind: "callable_port",
      },
      providerCredential: null,
      nativeBindingId,
      runtimeId: `rcrt_${bytes(32, 6)}`,
      fence: {
        collaborationServerId,
        coordinatorLeaseId: `rccl_${bytes(16, 7)}`,
        coordinatorEpoch: 1,
      },
      operationSchemaId: "remote-claw/test-port-operation/v1",
      operationRef: "operation-1",
      operationDigest: bytes(32, 8),
    },
  };
}

function rawFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

describe("runtime-owner RPC framing and canonical JSON", () => {
  it("round-trips fragmented frames and coalesced frames", () => {
    const first = encodeRuntimeOwnerRpcFrame({ z: 2, a: [true, null, "ok"] });
    const second = encodeRuntimeOwnerRpcFrame({ value: 7 });
    const decoder = new RuntimeOwnerRpcFrameDecoder();

    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(first.subarray(2, 9))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(9), second]))).toEqual([
      { a: [true, null, "ok"], z: 2 },
      { value: 7 },
    ]);
    expect(() => decoder.end()).not.toThrow();
  });

  it("rejects noncanonical, duplicate-key, malformed, and truncated input", () => {
    expect(() => decodeRuntimeOwnerRpcCanonicalJson(Buffer.from('{"z":1,"a":2}'))).toThrow(
      RuntimeOwnerRpcError,
    );
    expect(() => decodeRuntimeOwnerRpcCanonicalJson(Buffer.from('{"a":1,"a":1}'))).toThrow(
      RuntimeOwnerRpcError,
    );
    expect(() => decodeRuntimeOwnerRpcCanonicalJson(Buffer.from('{"a":'))).toThrow(
      RuntimeOwnerRpcError,
    );
    expect(() => decodeRuntimeOwnerRpcCanonicalJson(Buffer.from([0xff]))).toThrow(
      RuntimeOwnerRpcError,
    );

    const decoder = new RuntimeOwnerRpcFrameDecoder();
    decoder.push(rawFrame('{"a":1}').subarray(0, 6));
    expect(() => decoder.end()).toThrow(RuntimeOwnerRpcError);
  });

  it("rejects zero and oversized declared lengths before buffering a body", () => {
    const zero = Buffer.alloc(4);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(RUNTIME_OWNER_RPC_MAX_FRAME_BYTES + 1, 0);
    expect(() => new RuntimeOwnerRpcFrameDecoder().push(zero)).toThrow(RuntimeOwnerRpcError);
    expect(() => new RuntimeOwnerRpcFrameDecoder().push(oversized)).toThrow(RuntimeOwnerRpcError);
  });

  it("uses a single deterministic JSON representation", () => {
    expect(Buffer.from(encodeRuntimeOwnerRpcCanonicalJson({ b: 2, a: 1 })).toString()).toBe(
      '{"a":1,"b":2}',
    );
    expect(() => encodeRuntimeOwnerRpcCanonicalJson(-0)).toThrow(RuntimeOwnerRpcError);
    expect(() => encodeRuntimeOwnerRpcCanonicalJson(1.5)).toThrow(RuntimeOwnerRpcError);
    expect(() => encodeRuntimeOwnerRpcCanonicalJson({ value: undefined })).toThrow(
      RuntimeOwnerRpcError,
    );
    expect(() => encodeRuntimeOwnerRpcCanonicalJson("bad\0value")).toThrow(RuntimeOwnerRpcError);
  });

  it("parses and freezes the exact disjoint reverse-port protocol", () => {
    const reverseRequestId = runtimeOwnerRpcReverseRequestId(new Uint8Array(16).fill(9));
    expect(reverseRequestId).toBe(`rcrq_${bytes(16, 9)}`);
    expect(parseRuntimeOwnerRpcReverseRequestId(reverseRequestId)).toBe(reverseRequestId);
    expect(() => parseRuntimeOwnerRpcReverseRequestId(bytes(16, 9))).toThrow(RuntimeOwnerRpcError);

    const invocation = portInvocation();
    const request = parseRuntimeOwnerRpcPortRequest({
      version: RUNTIME_OWNER_RPC_VERSION,
      type: "port_request",
      reverseRequestId,
      invocation,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.invocation)).toBe(true);
    expect(Object.isFrozen(request.invocation.ownerFence)).toBe(true);
    expect(Object.isFrozen(request.invocation.request)).toBe(true);
    expect(Object.isFrozen(request.invocation.request.callablePortRef)).toBe(true);

    const result = {
      ...request.invocation.request,
      resultSchemaId: "remote-claw/test-port-result/v1",
      resultRef: "result-1",
      resultDigest: bytes(32, 10),
    };
    const response = parseRuntimeOwnerRpcPortResponse({
      version: RUNTIME_OWNER_RPC_VERSION,
      type: "port_response",
      reverseRequestId,
      ok: true,
      result,
      error: null,
    });
    expect(response).toMatchObject({ ok: true, reverseRequestId });
    expect(Object.isFrozen(response)).toBe(true);
    expect(response.ok && Object.isFrozen(response.result)).toBe(true);

    expect(() =>
      parseRuntimeOwnerRpcPortRequest({
        version: RUNTIME_OWNER_RPC_VERSION,
        type: "port_request",
        reverseRequestId,
        invocation: { ...invocation, nativeIncarnation: 0 },
      }),
    ).toThrow(RuntimeOwnerRpcError);
    expect(() =>
      parseRuntimeOwnerRpcPortRequest({
        version: RUNTIME_OWNER_RPC_VERSION,
        type: "port_request",
        reverseRequestId,
        invocation,
        rawPort: "forbidden",
      }),
    ).toThrow(RuntimeOwnerRpcError);

    const credentialUse = {
      providerCredentialRef: {
        protectedHandleId: `rcph_${bytes(16, 11)}`,
        kind: "provider_credential",
      },
      connectorId: "connector-1",
      credentialPurpose: "invoke-port",
    };
    expect(
      parseRuntimeOwnerRpcPortRequest({
        version: RUNTIME_OWNER_RPC_VERSION,
        type: "port_request",
        reverseRequestId,
        invocation: {
          ...invocation,
          request: { ...invocation.request, providerCredential: credentialUse },
        },
      }).invocation.request.providerCredential,
    ).toEqual(credentialUse);
    expect(() =>
      parseRuntimeOwnerRpcPortRequest({
        version: RUNTIME_OWNER_RPC_VERSION,
        type: "port_request",
        reverseRequestId,
        invocation: {
          ...invocation,
          request: {
            ...invocation.request,
            providerCredential: { ...credentialUse, rawCredential: "forbidden" },
          },
        },
      }),
    ).toThrow(RuntimeOwnerRpcError);
  });
});
