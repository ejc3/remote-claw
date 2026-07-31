import { describe, expect, it } from "vitest";
import type { FrameHeader } from "./aad.js";
import { AeadError, type Frame, open, seal, sealWith } from "./aead.js";
import { fromHex, toHex, utf8 } from "./bytes.js";

const KEY = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const KEY2 = fromHex("ff".repeat(32));

function header(over: Partial<FrameHeader> = {}): FrameHeader {
  return {
    v: 1,
    identityId: fromHex("00112233445566778899aabbccddeeff"),
    sessionId: "s1",
    dir: "out",
    recordKind: "assistant",
    seq: 1,
    msgId: "m1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...over,
  };
}

describe("AEAD round-trip", () => {
  it("recovers the plaintext", async () => {
    const pt = utf8("hello remote-claw");
    const frame = await seal(KEY, header(), pt);
    expect(toHex(await open(KEY, frame))).toBe(toHex(pt));
  });

  it("round-trips an empty plaintext (ct is just the 16-byte tag)", async () => {
    const frame = await seal(KEY, header(), new Uint8Array(0));
    expect(frame.ct.length).toBe(16);
    expect((await open(KEY, frame)).length).toBe(0);
  });

  it("ct length = plaintext length + 16 (GCM tag)", async () => {
    const pt = crypto.getRandomValues(new Uint8Array(100));
    const frame = await seal(KEY, header(), pt);
    expect(frame.ct.length).toBe(116);
  });

  it("uses fresh salt + nonce per call", async () => {
    const pt = utf8("x");
    const a = await seal(KEY, header(), pt);
    const b = await seal(KEY, header(), pt);
    expect(toHex(a.salt)).not.toBe(toHex(b.salt));
    expect(toHex(a.nonce)).not.toBe(toHex(b.nonce));
    expect(toHex(a.ct)).not.toBe(toHex(b.ct));
  });

  it("seals an entry snapshot even if the caller mutates inputs during awaits", async () => {
    const mutableHeader = header();
    const plaintext = utf8("snapshot");
    const salt = fromHex("aa".repeat(32));
    const nonce = fromHex("bb".repeat(12));
    const promise = sealWith(KEY, mutableHeader, plaintext, salt, nonce);

    mutableHeader.sessionId = "changed";
    mutableHeader.identityId[0] = 0xff;
    plaintext[0] = 0xff;
    salt[0] = 0xff;
    nonce[0] = 0xff;

    const frame = await promise;
    expect(frame.sessionId).toBe("s1");
    expect(toHex(frame.identityId)).toBe("00112233445566778899aabbccddeeff");
    expect(toHex(frame.salt)).toBe("aa".repeat(32));
    expect(toHex(frame.nonce)).toBe("bb".repeat(12));
    expect(toHex(await open(KEY, frame))).toBe(toHex(utf8("snapshot")));
  });
});

describe("AEAD rejection (integrity)", () => {
  const tamper = (b: Uint8Array, i = 0) => {
    const c = b.slice();
    c[i] = (c[i] ?? 0) ^ 0xff;
    return c;
  };

  it("rejects a flipped ciphertext byte", async () => {
    const f = await seal(KEY, header(), utf8("secret"));
    await expect(open(KEY, { ...f, ct: tamper(f.ct) })).rejects.toBeInstanceOf(AeadError);
  });

  it("rejects a flipped nonce", async () => {
    const f = await seal(KEY, header(), utf8("secret"));
    await expect(open(KEY, { ...f, nonce: tamper(f.nonce) })).rejects.toBeInstanceOf(AeadError);
  });

  it("rejects a flipped salt (different K_msg)", async () => {
    const f = await seal(KEY, header(), utf8("secret"));
    await expect(open(KEY, { ...f, salt: tamper(f.salt) })).rejects.toBeInstanceOf(AeadError);
  });

  it("rejects tampering of EVERY authenticated header field (AAD binding)", async () => {
    const f = await seal(KEY, header({ dir: "in" }), utf8("secret"));
    const mutations: Partial<Frame>[] = [
      { v: 2 },
      { identityId: fromHex("ffeeddccbbaa99887766554433221100") },
      { sessionId: "other" },
      { dir: "out" },
      { recordKind: "user" },
      { seq: 999 },
      { seq: null },
      { msgId: "evil" },
      { clientMsgId: "injected" }, // base has none → adding one changes AAD
      { keyEpoch: 1 },
      { part: 1 },
      { parts: 2 },
    ];
    for (const m of mutations) {
      await expect(open(KEY, { ...f, ...m })).rejects.toBeInstanceOf(AeadError);
    }
  });

  it("rejects the wrong key", async () => {
    const f = await seal(KEY, header(), utf8("secret"));
    await expect(open(KEY2, f)).rejects.toBeInstanceOf(AeadError);
  });

  it("opens an entry snapshot even if the caller mutates the frame during awaits", async () => {
    const original = await seal(KEY, header(), utf8("snapshot"));
    const mutable: Frame = {
      ...original,
      identityId: original.identityId.slice(),
      salt: original.salt.slice(),
      nonce: original.nonce.slice(),
      ct: original.ct.slice(),
    };
    const promise = open(KEY, mutable);

    mutable.sessionId = "changed";
    mutable.identityId[0] = 0xff;
    mutable.salt[0] = 0xff;
    mutable.nonce[0] = 0xff;
    mutable.ct[0] = 0xff;

    expect(toHex(await promise)).toBe(toHex(utf8("snapshot")));
  });

  it("derives independent ciphertext per plane key (no cross-plane confusion)", async () => {
    // Same header + plaintext + salt + nonce under two different plane keys must NOT collide,
    // and a frame is only openable by the key that sealed it.
    const SALT = fromHex("cc".repeat(32));
    const NONCE = fromHex("dd".repeat(12));
    const pt = utf8("same message");
    const a = await sealWith(KEY, header(), pt, SALT, NONCE);
    const b = await sealWith(KEY2, header(), pt, SALT, NONCE);
    expect(toHex(a.ct)).not.toBe(toHex(b.ct));
    expect(toHex(await open(KEY, a))).toBe(toHex(pt));
    await expect(open(KEY2, a)).rejects.toBeInstanceOf(AeadError);
  });

  it("rejects malformed salt/nonce lengths", async () => {
    const f = await seal(KEY, header(), utf8("secret"));
    await expect(open(KEY, { ...f, salt: f.salt.slice(0, 31) })).rejects.toBeInstanceOf(AeadError);
    await expect(open(KEY, { ...f, nonce: f.nonce.slice(0, 11) })).rejects.toBeInstanceOf(
      AeadError,
    );
    await expect(
      sealWith(KEY, header(), utf8("x"), new Uint8Array(31), new Uint8Array(12)),
    ).rejects.toBeInstanceOf(AeadError);
  });
});

describe("AEAD deterministic vector (cross-runtime decrypt KAT)", () => {
  const SALT = fromHex("aa".repeat(32));
  const NONCE = fromHex("bb".repeat(12));

  it("seals to a stable ciphertext and opens back", async () => {
    const frame = await sealWith(KEY, header(), utf8("hello remote-claw"), SALT, NONCE);
    expect(toHex(frame.ct)).toMatchInlineSnapshot(
      `"0fe96d53cc7df738dd3fca4b779885c89ff14d81fd62a4991f0039e5c0ec9471cc"`,
    );
    // and the round-trip holds on the pinned frame
    const reopened: Frame = { ...header(), salt: SALT, nonce: NONCE, ct: frame.ct };
    expect(toHex(await open(KEY, reopened))).toBe(toHex(utf8("hello remote-claw")));
  });
});
