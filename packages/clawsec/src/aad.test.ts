import { describe, expect, it } from "vitest";
import { canonicalAad, type FrameHeader } from "./aad.js";
import { fromHex, toHex } from "./bytes.js";

function base(): FrameHeader {
  return {
    v: 1,
    identityId: fromHex("00112233445566778899aabbccddeeff"),
    sessionId: "sess-1",
    dir: "out",
    recordKind: "assistant",
    seq: 7,
    msgId: "m-1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
  };
}
const hex = (h: FrameHeader) => toHex(canonicalAad(h));

describe("canonicalAad (§4.3/§8)", () => {
  it("is deterministic", () => {
    expect(hex(base())).toBe(hex(base()));
  });

  it("changes when ANY field changes (binds every field)", () => {
    const b = hex(base());
    const mutations: FrameHeader[] = [
      { ...base(), v: 2 },
      { ...base(), identityId: fromHex("ffeeddccbbaa99887766554433221100") },
      { ...base(), sessionId: "sess-2" },
      { ...base(), dir: "in" },
      { ...base(), recordKind: "user" },
      { ...base(), seq: 8 },
      { ...base(), seq: null },
      { ...base(), msgId: "m-2" },
      { ...base(), clientMsgId: "c-1" },
      { ...base(), keyEpoch: 1 },
      { ...base(), part: 1 },
      { ...base(), parts: 2 },
    ];
    for (const m of mutations) expect(hex(m)).not.toBe(b);
    // and all mutations are pairwise distinct
    expect(new Set([b, ...mutations.map(hex)]).size).toBe(mutations.length + 1);
  });

  it("distinguishes null seq from seq 0", () => {
    expect(hex({ ...base(), seq: null })).not.toBe(hex({ ...base(), seq: 0 }));
  });

  it("distinguishes absent / empty / present clientMsgId", () => {
    const absent = hex(base()); // base() omits clientMsgId
    const empty = hex({ ...base(), clientMsgId: "" });
    const present = hex({ ...base(), clientMsgId: "x" });
    expect(new Set([absent, empty, present]).size).toBe(3);
  });

  it("adapts only an undefined clientMsgId to the absent encoding", () => {
    const explicitlyUndefined = {
      ...base(),
      clientMsgId: undefined,
    } as unknown as FrameHeader;
    expect(hex(explicitlyUndefined)).toBe(hex(base()));
  });

  it("rejects explicit null and non-string clientMsgId values instead of aliasing omission", () => {
    for (const clientMsgId of [null, 0, false, {}]) {
      const malformed = { ...base(), clientMsgId } as unknown as FrameHeader;
      expect(() => canonicalAad(malformed)).toThrowError(
        "clientMsgId must be a string when present",
      );
    }
  });

  it("is injective across field boundaries (length-prefixing)", () => {
    const h1 = { ...base(), sessionId: "a", msgId: "bc" };
    const h2 = { ...base(), sessionId: "ab", msgId: "c" };
    expect(hex(h1)).not.toBe(hex(h2));
  });

  it("binds multi-byte UTF-8 strings injectively", () => {
    const a = hex({ ...base(), sessionId: "séssion-🔐", msgId: "m" });
    const b = hex({ ...base(), sessionId: "séssion-🔐x", msgId: "" });
    expect(a).not.toBe(b);
    expect(a).toBe(hex({ ...base(), sessionId: "séssion-🔐", msgId: "m" })); // deterministic
  });

  it("accepts MAX_SAFE_INTEGER for uint fields", () => {
    expect(() => canonicalAad({ ...base(), seq: Number.MAX_SAFE_INTEGER })).not.toThrow();
    expect(() => canonicalAad({ ...base(), seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError);
  });

  it("rejects malformed headers", () => {
    expect(() => canonicalAad({ ...base(), identityId: fromHex("0011") })).toThrow(RangeError);
    expect(() => canonicalAad({ ...base(), identityId: fromHex("00".repeat(17)) })).toThrow(
      RangeError,
    );
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime dir guard
    expect(() => canonicalAad({ ...base(), dir: "sideways" as any })).toThrow(RangeError);
    expect(() => canonicalAad({ ...base(), part: -1 })).toThrow(RangeError);
    expect(() => canonicalAad({ ...base(), v: 1.5 })).toThrow(RangeError);
    expect(() => canonicalAad({ ...base(), seq: -1 })).toThrow(RangeError);
  });

  it("uses the intrinsic identity byte length instead of an overridable getter", () => {
    class SpoofedIdentity extends Uint8Array {
      override get length(): number {
        return 16;
      }
    }
    expect(() => canonicalAad({ ...base(), identityId: new SpoofedIdentity([0xaa]) })).toThrowError(
      "identityId must be 16 bytes, got 1",
    );
  });

  it("snapshots accessor-backed fields once before validating and encoding", () => {
    let identityReads = 0;
    let dirReads = 0;
    const accessorHeader = { ...base() };
    Object.defineProperties(accessorHeader, {
      identityId: {
        enumerable: true,
        get() {
          identityReads++;
          return identityReads === 1 ? base().identityId : Uint8Array.of(0xaa);
        },
      },
      dir: {
        enumerable: true,
        get() {
          dirReads++;
          return dirReads === 1 ? "out" : "sideways";
        },
      },
    });

    expect(toHex(canonicalAad(accessorHeader))).toBe(hex(base()));
    expect(identityReads).toBe(1);
    expect(dirReads).toBe(1);
  });

  it("validates and encodes one identity snapshot when its SharedArrayBuffer view grows", () => {
    const initialIdentity = base().identityId;
    const expected = hex({ ...base(), identityId: initialIdentity });
    const backing = Reflect.construct(SharedArrayBuffer, [
      initialIdentity.length,
      { maxByteLength: initialIdentity.length + 1 },
    ]) as SharedArrayBuffer & {
      grow(newByteLength: number): void;
    };
    const identityId = new Uint8Array(backing);
    identityId.set(initialIdentity);
    const originalSetUint32 = DataView.prototype.setUint32;
    let grew = false;
    DataView.prototype.setUint32 = function growAfterIdentityValidation(
      byteOffset,
      value,
      littleEndian,
    ): void {
      if (!grew) {
        grew = true;
        backing.grow(initialIdentity.length + 1);
        new Uint8Array(backing)[initialIdentity.length] = 0xff;
      }
      originalSetUint32.call(this, byteOffset, value, littleEndian);
    };

    try {
      expect(hex({ ...base(), identityId })).toBe(expected);
    } finally {
      DataView.prototype.setUint32 = originalSetUint32;
    }
    expect(grew).toBe(true);
    expect(identityId.length).toBe(initialIdentity.length + 1);
  });

  it("retains the locked pre-writer-extraction known-answer vector", () => {
    expect(hex(base())).toMatchInlineSnapshot(
      `"0000000800000000000000010000001000112233445566778899aabbccddeeff00000006736573732d31000000036f757400000009617373697374616e7401000000080000000000000007000000036d2d3100000000080000000000000000000000080000000000000000000000080000000000000001"`,
    );
  });
});
