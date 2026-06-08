import { describe, expect, it } from "vitest";
import { fromHex, sha256, toHex } from "./bytes.js";
import { deriveIdentity, deriveSessionKey, type Identity } from "./kdf.js";
import { generateSecret } from "./secret.js";

// A fixed secret S = 0x00 01 02 … 1f, used to lock cross-runtime determinism.
const FIXED = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

describe("deriveIdentity (§4.2)", () => {
  it("produces correctly-sized keys", async () => {
    const id = await deriveIdentity(FIXED);
    expect(id.authToken.length).toBe(32);
    expect(id.identityId.length).toBe(16);
    expect(id.contentRoot.length).toBe(32);
    expect(id.controlKey.length).toBe(32);
    expect(id.kMeta.length).toBe(32);
  });

  it("identity_id = trunc(SHA256(auth_token), 16)", async () => {
    const id = await deriveIdentity(FIXED);
    const expected = (await sha256(id.authToken)).slice(0, 16);
    expect(toHex(id.identityId)).toBe(toHex(expected));
  });

  it("is deterministic for a given secret", async () => {
    const a = await deriveIdentity(FIXED);
    const b = await deriveIdentity(FIXED);
    for (const k of Object.keys(a) as (keyof Identity)[]) {
      expect(toHex(a[k])).toBe(toHex(b[k]));
    }
  });

  it("domain-separates the siblings (all four expand keys differ)", async () => {
    const id = await deriveIdentity(FIXED);
    const keys = [id.authToken, id.contentRoot, id.controlKey, id.kMeta].map(toHex);
    expect(new Set(keys).size).toBe(4);
  });

  it("different secrets yield entirely different key sets", async () => {
    const a = await deriveIdentity(FIXED);
    const b = await deriveIdentity(await generateSecret().then((g) => g.secret));
    expect(toHex(a.authToken)).not.toBe(toHex(b.authToken));
    expect(toHex(a.contentRoot)).not.toBe(toHex(b.contentRoot));
    expect(toHex(a.controlKey)).not.toBe(toHex(b.controlKey));
    expect(toHex(a.kMeta)).not.toBe(toHex(b.kMeta));
    expect(toHex(a.identityId)).not.toBe(toHex(b.identityId));
  });

  it("matches the locked known-answer vector (cross-runtime regression)", async () => {
    const id = await deriveIdentity(FIXED);
    expect({
      authToken: toHex(id.authToken),
      identityId: toHex(id.identityId),
      contentRoot: toHex(id.contentRoot),
      controlKey: toHex(id.controlKey),
      kMeta: toHex(id.kMeta),
    }).toMatchInlineSnapshot(`
      {
        "authToken": "29e4dcf719c92bbb470ad638e472ab7860f9d4c3dc37e5add71057f0d315260c",
        "contentRoot": "0366d2ae64a1db22b19647695898cb364e3ab162c29203b72c4597d64dd27124",
        "controlKey": "d82ba705753c494b272f5801e299caffb6288b7a7a48939c695f88c556935724",
        "identityId": "afc18b557009f634ec97b4782b22e7b4",
        "kMeta": "825c9f35e2eb03d37e9697c912c3da686f6fb75677e351cadbacf103c3230d5f",
      }
    `);
  });
});

describe("deriveSessionKey (§4.3)", () => {
  it("is a 32-byte key, deterministic per (content_root, session_id)", async () => {
    const { contentRoot } = await deriveIdentity(FIXED);
    const a = await deriveSessionKey(contentRoot, "sess-123");
    const b = await deriveSessionKey(contentRoot, "sess-123");
    expect(a.length).toBe(32);
    expect(toHex(a)).toBe(toHex(b));
  });

  it("differs by session_id and by content_root", async () => {
    const { contentRoot } = await deriveIdentity(FIXED);
    const k1 = await deriveSessionKey(contentRoot, "sess-1");
    const k2 = await deriveSessionKey(contentRoot, "sess-2");
    expect(toHex(k1)).not.toBe(toHex(k2));
    const otherRoot = (await deriveIdentity(await generateSecret().then((g) => g.secret)))
      .contentRoot;
    const k3 = await deriveSessionKey(otherRoot, "sess-1");
    expect(toHex(k3)).not.toBe(toHex(k1));
  });

  it("matches the locked K_session vector (independently reproduced)", async () => {
    // S = 00..1f, session_id = "sess-123". Cross-checked against an independent HKDF impl.
    const { contentRoot } = await deriveIdentity(FIXED);
    const k = await deriveSessionKey(contentRoot, "sess-123");
    expect(toHex(k)).toBe("8248cd0ab8a6771a5e7847086dc185ebdcc8ba71e47388438df3de07f3d8e2a4");
  });

  it("handles empty and non-ASCII session ids deterministically", async () => {
    const { contentRoot } = await deriveIdentity(FIXED);
    expect((await deriveSessionKey(contentRoot, "")).length).toBe(32);
    const u1 = await deriveSessionKey(contentRoot, "séssion-🔐");
    const u2 = await deriveSessionKey(contentRoot, "séssion-🔐");
    expect(toHex(u1)).toBe(toHex(u2));
    expect(toHex(u1)).not.toBe(toHex(await deriveSessionKey(contentRoot, "")));
  });
});
