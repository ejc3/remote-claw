import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { normalizeChecksum } from "./checksum.js";
import { formatSecret, generateSecret, parseSecret, SecretError } from "./secret.js";

const PREFIX = "rc1_";
const TOKEN_LEN = PREFIX.length + 43 + 4; // 51

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(bytesEqual(base64urlDecode(base64urlEncode(bytes)), bytes)).toBe(true);
    }
  });

  it("emits no padding and url-safe alphabet only", () => {
    const s = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s).not.toContain("=");
  });

  it("rejects out-of-alphabet input", () => {
    expect(() => base64urlDecode("abc!def")).toThrow();
  });

  it("handles the empty byte array", () => {
    expect(base64urlEncode(new Uint8Array(0))).toBe("");
    expect(base64urlDecode("").length).toBe(0);
  });
});

describe("secret format (§4.1)", () => {
  it("generates a well-formed rc1_ token that round-trips", async () => {
    const { secret, token } = await generateSecret();
    expect(secret.length).toBe(32);
    expect(token.startsWith(PREFIX)).toBe(true);
    expect(token.length).toBe(TOKEN_LEN);
    expect(token.slice(PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(bytesEqual(await parseSecret(token), secret)).toBe(true);
  });

  it("round-trips many fresh secrets", async () => {
    for (let i = 0; i < 50; i++) {
      const { secret, token } = await generateSecret();
      expect(bytesEqual(await parseSecret(token), secret)).toBe(true);
    }
  });

  it("formatSecret is deterministic for a fixed secret", async () => {
    const s = new Uint8Array(32).fill(7);
    expect(await formatSecret(s)).toBe(await formatSecret(s));
  });

  it("rejects a non-32-byte secret", async () => {
    await expect(formatSecret(new Uint8Array(16))).rejects.toMatchObject({ reason: "bad-length" });
  });
});

describe("parseSecret rejection", () => {
  it("bad-prefix", async () => {
    const { token } = await generateSecret();
    await expect(parseSecret(`xx_${token.slice(3)}`)).rejects.toMatchObject({
      reason: "bad-prefix",
    });
    await expect(parseSecret(token.slice(1))).rejects.toMatchObject({ reason: "bad-prefix" });
  });

  it("bad-length (truncated / extended)", async () => {
    const { token } = await generateSecret();
    await expect(parseSecret(token.slice(0, -1))).rejects.toMatchObject({ reason: "bad-length" });
    await expect(parseSecret(`${token}A`)).rejects.toMatchObject({ reason: "bad-length" });
  });

  it("bad-encoding (illegal char in body)", async () => {
    const { token } = await generateSecret();
    const mutated = `${PREFIX}!${token.slice(PREFIX.length + 1)}`; // '!' is not base64url
    await expect(parseSecret(mutated)).rejects.toMatchObject({ reason: "bad-encoding" });
  });

  it("bad-checksum (deliberately wrong)", async () => {
    const { token } = await generateSecret();
    const cksum = token.slice(-4);
    const firstWrong = cksum[0] === "0" ? "1" : "0"; // guaranteed different first char
    const mutated = token.slice(0, -4) + firstWrong + cksum.slice(1);
    await expect(parseSecret(mutated)).rejects.toMatchObject({ reason: "bad-checksum" });
  });

  it("bad-checksum on a single flipped body byte", async () => {
    // A flipped secret byte changes SHA-256(S) and thus the checksum w.p. ~1-2^-20.
    const { secret } = await generateSecret();
    const flipped = secret.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const goodToken = await formatSecret(secret);
    const flippedBody = (await formatSecret(flipped)).slice(PREFIX.length, PREFIX.length + 43);
    const frankenToken = PREFIX + flippedBody + goodToken.slice(-4);
    await expect(parseSecret(frankenToken)).rejects.toMatchObject({ reason: "bad-checksum" });
  });

  it("bad-encoding on a non-canonical base64url body", async () => {
    // For the all-zero secret the canonical body is "A"×43; the last base64 char carries 2
    // unused bits, so "…A"→"…B" decodes to the same 32 zero bytes and (without the canonical
    // check) would pass the unchanged checksum. Each secret must have exactly one token.
    const token = await formatSecret(new Uint8Array(32));
    const lastBodyIdx = PREFIX.length + 42;
    const nonCanonical = `${token.slice(0, lastBodyIdx)}B${token.slice(lastBodyIdx + 1)}`;
    expect(nonCanonical).not.toBe(token);
    await expect(parseSecret(nonCanonical)).rejects.toMatchObject({ reason: "bad-encoding" });
  });

  it("bad-prefix on empty / non-string input", async () => {
    await expect(parseSecret("")).rejects.toMatchObject({ reason: "bad-prefix" });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising the runtime guard
    await expect(parseSecret(123 as any)).rejects.toMatchObject({ reason: "bad-prefix" });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising the runtime guard
    await expect(parseSecret(null as any)).rejects.toMatchObject({ reason: "bad-prefix" });
  });
});

describe("checksum transcription tolerance (Crockford)", () => {
  it("normalizeChecksum maps O→0, I/L→1, and uppercases", () => {
    expect(normalizeChecksum("oilOIL")).toBe("011011");
    expect(normalizeChecksum("abc")).toBe("ABC");
    // valid Crockford chars (no I/L/O) are preserved, only uppercased
    expect(normalizeChecksum("ABCXYZ239")).toBe("ABCXYZ239");
    expect(normalizeChecksum("hjkmnpq")).toBe("HJKMNPQ");
  });

  it("accepts a lowercased checksum", async () => {
    const { secret, token } = await generateSecret();
    const tolerant = token.slice(0, -4) + token.slice(-4).toLowerCase();
    expect(bytesEqual(await parseSecret(tolerant), secret)).toBe(true);
  });
});

describe("SecretError", () => {
  it("is detectable via static is()", async () => {
    try {
      await parseSecret("not-a-token");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(SecretError.is(e)).toBe(true);
    }
  });
});
