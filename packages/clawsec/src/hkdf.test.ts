import { describe, expect, it } from "vitest";
import { fromHex, toHex } from "./bytes.js";
import { hkdfExpand, hkdfExtract } from "./hkdf.js";

// RFC 5869 Appendix A test vectors (SHA-256 cases).
describe("HKDF-SHA256 (RFC 5869 vectors)", () => {
  it("Test Case 1", async () => {
    const ikm = fromHex("0b".repeat(22));
    const salt = fromHex("000102030405060708090a0b0c");
    const info = fromHex("f0f1f2f3f4f5f6f7f8f9");
    const prk = await hkdfExtract(salt, ikm);
    expect(toHex(prk)).toBe("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5");
    const okm = await hkdfExpand(prk, info, 42);
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  it("Test Case 3 (zero-length salt and info)", async () => {
    const ikm = fromHex("0b".repeat(22));
    const prk = await hkdfExtract(new Uint8Array(0), ikm);
    expect(toHex(prk)).toBe("19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04");
    const okm = await hkdfExpand(prk, new Uint8Array(0), 42);
    expect(toHex(okm)).toBe(
      "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    );
  });

  it("expands across multiple HMAC blocks (length > 32)", async () => {
    const prk = await hkdfExtract(fromHex("00"), fromHex("11".repeat(32)));
    const okm = await hkdfExpand(prk, fromHex("22"), 80);
    expect(okm.length).toBe(80);
    // first 32 bytes equal a 32-byte expand (T(1) is shared)
    const okm32 = await hkdfExpand(prk, fromHex("22"), 32);
    expect(toHex(okm.slice(0, 32))).toBe(toHex(okm32));
  });

  it("rejects an out-of-range length", async () => {
    const prk = await hkdfExtract(fromHex("00"), fromHex("11"));
    await expect(hkdfExpand(prk, new Uint8Array(0), 255 * 32 + 1)).rejects.toThrow(RangeError);
  });

  it("expands to zero length", async () => {
    const prk = await hkdfExtract(fromHex("00"), fromHex("11"));
    expect((await hkdfExpand(prk, new Uint8Array(0), 0)).length).toBe(0);
  });
});
