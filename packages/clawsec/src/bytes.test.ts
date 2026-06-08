import { describe, expect, it } from "vitest";
import { fromHex, timingSafeEqual, toHex, utf8 } from "./bytes.js";

describe("hex", () => {
  it("round-trips toHex/fromHex", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(toHex(fromHex(toHex(bytes)))).toBe(toHex(bytes));
    }
  });

  it("toHex zero-pads each byte", () => {
    expect(toHex(Uint8Array.of(0, 1, 15, 16, 255))).toBe("00010f10ff");
  });

  it("fromHex rejects odd length, non-hex, and whitespace (parseInt lenience)", () => {
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("0g")).toThrow();
    expect(() => fromHex("f-")).toThrow();
    expect(() => fromHex(" 1")).toThrow();
  });
});

describe("utf8", () => {
  it("encodes ASCII and multi-byte code points", () => {
    expect(toHex(utf8("AB"))).toBe("4142");
    expect(utf8("€").length).toBe(3); // U+20AC is 3 UTF-8 bytes
  });
});

describe("timingSafeEqual", () => {
  it("is true for equal byte arrays (including empty)", () => {
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    for (let n = 1; n < 40; n++) {
      const a = crypto.getRandomValues(new Uint8Array(n));
      expect(timingSafeEqual(a, Uint8Array.from(a))).toBe(true);
    }
  });

  it("is false when any single byte differs", () => {
    const a = crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < a.length; i++) {
      const b = Uint8Array.from(a);
      b[i] = (b[i] ?? 0) ^ 0xff; // flip every bit of one byte
      expect(timingSafeEqual(a, b)).toBe(false);
    }
  });

  it("is false for different lengths, including prefixes", () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(0), Uint8Array.of(0))).toBe(false);
  });

  it("distinguishes a 0x00 byte from a missing one (no length collapse)", () => {
    // Guards against an XOR-only impl that would call [1,0] equal to [1].
    expect(timingSafeEqual(Uint8Array.of(1, 0), Uint8Array.of(1))).toBe(false);
  });
});
