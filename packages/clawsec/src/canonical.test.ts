import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode, CanonicalWriter, toHex } from "./index.js";

function encoded(write: (writer: CanonicalWriter) => void): string {
  const writer = new CanonicalWriter();
  write(writer);
  return toHex(writer.finish());
}

describe("CanonicalWriter (§4.3)", () => {
  it("matches the exact primitive field encodings", () => {
    expect(encoded((writer) => writer.bytes(Uint8Array.of(0xab, 0xcd)))).toBe("00000002abcd");
    expect(encoded((writer) => writer.str("é"))).toBe("00000002c3a9");
    expect(encoded((writer) => writer.uint(0))).toBe("000000080000000000000000");
    expect(encoded((writer) => writer.uint(Number.MAX_SAFE_INTEGER))).toBe(
      "00000008001fffffffffffff",
    );
  });

  it("matches the exact optionalUint encodings", () => {
    expect(encoded((writer) => writer.optionalUint(null))).toBe("00");
    expect(encoded((writer) => writer.optionalUint(0))).toBe("01000000080000000000000000");
    expect(encoded((writer) => writer.optionalUint(7))).toBe("01000000080000000000000007");
  });

  it("matches the exact optionalStr encodings", () => {
    expect(encoded((writer) => writer.optionalStr(null))).toBe("00");
    expect(encoded((writer) => writer.optionalStr(""))).toBe("0100000000");
    expect(encoded((writer) => writer.optionalStr("é"))).toBe("0100000002c3a9");
  });

  it("matches the exact optionalBytes encodings", () => {
    expect(encoded((writer) => writer.optionalBytes(null))).toBe("00");
    expect(encoded((writer) => writer.optionalBytes(new Uint8Array()))).toBe("0100000000");
    expect(encoded((writer) => writer.optionalBytes(Uint8Array.of(0, 0xff)))).toBe(
      "010000000200ff",
    );
  });

  it("requires explicit null for absent optional fields", () => {
    const strings = new CanonicalWriter();
    expect(() => strings.optionalStr(undefined as never)).toThrow(TypeError);
    expect(toHex(strings.finish())).toBe("");

    const bytes = new CanonicalWriter();
    expect(() => bytes.optionalBytes(undefined as never)).toThrow(TypeError);
    expect(toHex(bytes.finish())).toBe("");
  });

  it("rejects unsafe integers without partially appending a present value", () => {
    for (const value of [
      -1,
      -0,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const writer = new CanonicalWriter();
      expect(() => writer.uint(value)).toThrow(RangeError);
      expect(toHex(writer.finish())).toBe("");
    }

    const writer = new CanonicalWriter();
    expect(() => writer.optionalUint(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(toHex(writer.finish())).toBe("");
  });

  it("rejects non-numbers without coercing or echoing them", () => {
    let coerced = false;
    const hostile = {
      [Symbol.toPrimitive]() {
        coerced = true;
        return 0;
      },
    };
    for (const value of [hostile, Symbol("sensitive")]) {
      const writer = new CanonicalWriter();
      expect(() => writer.uint(value as never)).toThrowError(
        "expected a non-negative safe integer",
      );
      expect(toHex(writer.finish())).toBe("");
    }
    expect(coerced).toBe(false);
  });

  it("uses intrinsic typed-array length rather than an overridable getter", () => {
    class SpoofedLengthUint8Array extends Uint8Array {
      override get length(): number {
        return 0x1_0000_0000;
      }
    }
    const value = new SpoofedLengthUint8Array([0xaa]);
    expect(encoded((writer) => writer.bytes(value))).toBe("00000001aa");
  });

  it("uses the intrinsic typed-array brand rather than a spoofable display tag", () => {
    const spoofed = new Uint16Array([0x1234]);
    Object.defineProperty(spoofed, Symbol.toStringTag, { value: "Uint8Array" });

    const writer = new CanonicalWriter();
    expect(() => writer.bytes(spoofed as unknown as Uint8Array)).toThrowError(
      "expected Uint8Array",
    );
    expect(toHex(writer.finish())).toBe("");

    const genuine = Uint8Array.of(0xaa);
    Object.defineProperty(genuine, Symbol.toStringTag, { value: "Uint16Array" });
    expect(encoded((candidate) => candidate.bytes(genuine))).toBe("00000001aa");
  });

  it("rejects DataView and objects that merely inherit Uint8Array.prototype", () => {
    for (const value of [
      new DataView(new ArrayBuffer(1)),
      Object.create(Uint8Array.prototype) as unknown,
    ]) {
      const writer = new CanonicalWriter();
      expect(() => writer.bytes(value as Uint8Array)).toThrowError("expected Uint8Array");
      expect(toHex(writer.finish())).toBe("");
    }
  });

  it("accepts genuine cross-realm Uint8Arrays but rejects cross-realm tag spoofs", () => {
    const foreign = runInNewContext("new Uint8Array([0xaa])") as unknown as Uint8Array;
    expect(encoded((writer) => writer.bytes(foreign))).toBe("00000001aa");

    const spoofed = runInNewContext(`
      (() => {
        const value = new Uint16Array([0x1234]);
        Object.defineProperty(value, Symbol.toStringTag, { value: "Uint8Array" });
        return value;
      })()
    `) as unknown as Uint8Array;
    expect(() => encoded((writer) => writer.bytes(spoofed))).toThrowError("expected Uint8Array");
  });

  it("takes immutable snapshots of inputs and output", () => {
    const input = Uint8Array.of(0xaa);
    const writer = new CanonicalWriter();
    writer.bytes(input);
    input[0] = 0xbb;

    const first = writer.finish();
    expect(toHex(first)).toBe("00000001aa");
    first[4] = 0xcc;

    const second = writer.finish();
    expect(second).not.toBe(first);
    expect(toHex(second)).toBe("00000001aa");
    expect(() => writer.str("late")).toThrowError("canonical writer is already finished");
  });

  it("destroys retained field and finished-byte snapshots idempotently", () => {
    const writer = new CanonicalWriter();
    writer.bytes(Uint8Array.of(0xaa));
    const output = writer.finish();
    writer.destroy();
    writer.destroy();

    expect(toHex(output)).toBe("00000001aa");
    expect(() => writer.finish()).toThrowError("canonical writer was destroyed");
    expect(() => writer.bytes(Uint8Array.of(0xbb))).toThrowError("canonical writer was destroyed");
  });

  it("prefixes the copied snapshot when a length-tracking SharedArrayBuffer view grows", () => {
    const backing = Reflect.construct(SharedArrayBuffer, [
      1,
      { maxByteLength: 2 },
    ]) as SharedArrayBuffer & {
      grow(newByteLength: number): void;
    };
    const input = new Uint8Array(backing);
    input[0] = 0xaa;
    const originalSetUint32 = DataView.prototype.setUint32;
    let grew = false;
    DataView.prototype.setUint32 = function growBeforePrefixWrite(
      byteOffset,
      value,
      littleEndian,
    ): void {
      if (!grew) {
        grew = true;
        backing.grow(2);
        new Uint8Array(backing)[1] = 0xbb;
      }
      originalSetUint32.call(this, byteOffset, value, littleEndian);
    };

    try {
      expect(encoded((writer) => writer.bytes(input))).toBe("00000001aa");
    } finally {
      DataView.prototype.setUint32 = originalSetUint32;
    }
    expect(grew).toBe(true);
    expect(input.length).toBe(2);
  });

  it("copies Node Buffer inputs instead of retaining Buffer.slice aliases", () => {
    const input = Buffer.from([0xaa]);
    const writer = new CanonicalWriter();
    writer.bytes(input);
    input[0] = 0xbb;

    expect(toHex(writer.finish())).toBe("00000001aa");
  });

  it("accepts scalar pairs and rejects lone UTF-16 surrogates without appending", () => {
    expect(encoded((writer) => writer.str("😀"))).toBe("00000004f09f9880");

    for (const value of ["\ud800", "\udbff", "\udc00", "\udfff", `a\ud800b`]) {
      const required = new CanonicalWriter();
      expect(() => required.str(value)).toThrowError("Unicode scalar values");
      expect(toHex(required.finish())).toBe("");

      const optional = new CanonicalWriter();
      expect(() => optional.optionalStr(value)).toThrowError("Unicode scalar values");
      expect(toHex(optional.finish())).toBe("");
    }
  });

  it("exposes the cross-runtime base64url helpers from the package surface", () => {
    expect(base64urlEncode(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
    expect(base64urlDecode("-_8")).toEqual(Uint8Array.of(0xfb, 0xff));
  });
});
