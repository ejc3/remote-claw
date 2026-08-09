import { describe, expect, it } from "vitest";
import {
  decodeRuntimeOwnerRpcCanonicalJson,
  encodeRuntimeOwnerRpcCanonicalJson,
  encodeRuntimeOwnerRpcFrame,
  RUNTIME_OWNER_RPC_MAX_FRAME_BYTES,
  RuntimeOwnerRpcError,
  RuntimeOwnerRpcFrameDecoder,
} from "./protocol.js";

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
});
