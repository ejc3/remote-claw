import { describe, expect, it } from "vitest";
import { base64urlEncode } from "./base64url.js";
import { deriveIdentity, type Identity } from "./kdf.js";
import { formatPass, PassError, parsePass } from "./pass.js";
import { generateSecret } from "./secret.js";

const PREFIX = "rcp1_";
const B64_LEN = 171; // base64url of the 128-byte key bundle
const PASS_LEN = PREFIX.length + B64_LEN + 4; // 180

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function identityEqual(a: Identity, b: Identity): boolean {
  return (
    bytesEqual(a.authToken, b.authToken) &&
    bytesEqual(a.identityId, b.identityId) &&
    bytesEqual(a.contentRoot, b.contentRoot) &&
    bytesEqual(a.controlKey, b.controlKey) &&
    bytesEqual(a.kMeta, b.kMeta)
  );
}

/** An Identity built from explicit keys, for format-level edge cases (formatPass ignores id). */
function fakeIdentity(fill: number): Identity {
  const k = () => new Uint8Array(32).fill(fill);
  return {
    authToken: k(),
    identityId: new Uint8Array(16),
    contentRoot: k(),
    controlKey: k(),
    kMeta: k(),
  };
}

describe("pass format (§4.2a)", () => {
  it("round-trips a derived identity through format/parse", async () => {
    const { secret } = await generateSecret();
    const id = await deriveIdentity(secret);
    const pass = await formatPass(id);
    expect(pass.startsWith(PREFIX)).toBe(true);
    expect(pass.length).toBe(PASS_LEN);
    expect(pass.slice(PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{171}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(identityEqual(await parsePass(pass), id)).toBe(true);
  });

  it("round-trips many fresh identities", async () => {
    for (let i = 0; i < 30; i++) {
      const { secret } = await generateSecret();
      const id = await deriveIdentity(secret);
      expect(identityEqual(await parsePass(await formatPass(id)), id)).toBe(true);
    }
  });

  it("is deterministic for a fixed identity (exactly one token per pass)", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(7));
    expect(await formatPass(id)).toBe(await formatPass(id));
  });

  it("recomputes identity_id = trunc(SHA256(authToken),16) on parse", async () => {
    const { secret } = await generateSecret();
    const id = await deriveIdentity(secret);
    const parsed = await parsePass(await formatPass(id));
    expect(bytesEqual(parsed.identityId, id.identityId)).toBe(true); // self-verifies like the secret
    expect(parsed.identityId.length).toBe(16);
  });

  it("carries the derived keys but NOT the secret (one-way: a pass can't reveal S)", async () => {
    const { secret } = await generateSecret();
    const id = await deriveIdentity(secret);
    const pass = await formatPass(id);
    // the raw secret's bytes never appear in the pass payload
    expect(pass).not.toContain(base64urlEncode(secret));
    // and the parsed keys are the real derived keys, not S
    const parsed = await parsePass(pass);
    expect(bytesEqual(parsed.contentRoot, id.contentRoot)).toBe(true);
    expect(bytesEqual(parsed.authToken, secret)).toBe(false);
    expect(bytesEqual(parsed.contentRoot, secret)).toBe(false);
  });

  it("rejects EACH operational key at the wrong length at format time", async () => {
    const base = await deriveIdentity(new Uint8Array(32).fill(1));
    for (const key of ["authToken", "contentRoot", "controlKey", "kMeta"] as const) {
      await expect(formatPass({ ...base, [key]: new Uint8Array(16) })).rejects.toMatchObject({
        reason: "bad-length",
      });
    }
  });

  it("distinct identities produce distinct passes (no key-packing collision)", async () => {
    const a = await formatPass(await deriveIdentity(new Uint8Array(32).fill(1)));
    const b = await formatPass(await deriveIdentity(new Uint8Array(32).fill(2)));
    expect(a).not.toBe(b);
  });
});

describe("parsePass rejection", () => {
  async function aPass(): Promise<string> {
    return formatPass(await deriveIdentity(new Uint8Array(32).fill(3)));
  }

  it("bad-prefix", async () => {
    const pass = await aPass();
    await expect(parsePass(`rc1_${pass.slice(PREFIX.length)}`)).rejects.toMatchObject({
      reason: "bad-prefix",
    });
    await expect(parsePass(pass.slice(1))).rejects.toMatchObject({ reason: "bad-prefix" });
  });

  it("bad-length (truncated / extended)", async () => {
    const pass = await aPass();
    await expect(parsePass(pass.slice(0, -1))).rejects.toMatchObject({ reason: "bad-length" });
    await expect(parsePass(`${pass}A`)).rejects.toMatchObject({ reason: "bad-length" });
  });

  it("bad-encoding (illegal char in body)", async () => {
    const pass = await aPass();
    const mutated = `${PREFIX}!${pass.slice(PREFIX.length + 1)}`; // '!' is not base64url
    await expect(parsePass(mutated)).rejects.toMatchObject({ reason: "bad-encoding" });
  });

  it("bad-encoding on a non-canonical base64url body", async () => {
    // All-zero keys → canonical body ends in "A" whose last 2 bits are unused; "A"→"B" decodes to
    // the same 128 zero bytes, so the canonical check (one token per pass) must reject it.
    const pass = await formatPass(fakeIdentity(0));
    const lastBodyIdx = PREFIX.length + B64_LEN - 1;
    expect(pass[lastBodyIdx]).toBe("A");
    const nonCanonical = `${pass.slice(0, lastBodyIdx)}B${pass.slice(lastBodyIdx + 1)}`;
    expect(nonCanonical).not.toBe(pass);
    await expect(parsePass(nonCanonical)).rejects.toMatchObject({ reason: "bad-encoding" });
  });

  it("bad-checksum (deliberately wrong)", async () => {
    const pass = await aPass();
    const cksum = pass.slice(-4);
    const firstWrong = cksum[0] === "0" ? "1" : "0";
    await expect(parsePass(pass.slice(0, -4) + firstWrong + cksum.slice(1))).rejects.toMatchObject({
      reason: "bad-checksum",
    });
  });

  it("bad-checksum: the checksum is bound to the payload (one identity's body + another's checksum)", async () => {
    const a = await formatPass(await deriveIdentity(new Uint8Array(32).fill(4)));
    const b = await formatPass(await deriveIdentity(new Uint8Array(32).fill(5)));
    // b's body (a valid, canonical payload) carrying a's checksum → mismatch, not a silent accept
    const franken = b.slice(0, -4) + a.slice(-4);
    await expect(parsePass(franken)).rejects.toMatchObject({ reason: "bad-checksum" });
  });

  it("bad-prefix on empty / non-string input", async () => {
    await expect(parsePass("")).rejects.toMatchObject({ reason: "bad-prefix" });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising the runtime guard
    await expect(parsePass(123 as any)).rejects.toMatchObject({ reason: "bad-prefix" });
  });
});

describe("checksum tolerance & PassError", () => {
  it("accepts a lowercased checksum (Crockford transcription tolerance)", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(9));
    const pass = await formatPass(id);
    const tolerant = pass.slice(0, -4) + pass.slice(-4).toLowerCase();
    expect(identityEqual(await parsePass(tolerant), id)).toBe(true);
  });

  it("PassError is detectable via static is()", async () => {
    try {
      await parsePass("not-a-pass");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(PassError.is(e)).toBe(true);
    }
  });
});
