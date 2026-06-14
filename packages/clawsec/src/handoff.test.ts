import { describe, expect, it } from "vitest";
import { toHex, utf8 } from "./bytes.js";
import {
  decodeHandoffBox,
  encodeHandoffBox,
  formatOtk,
  generateOtk,
  HandoffError,
  handoffClaimProof,
  handoffId,
  handoffProofHash,
  openHandoff,
  parseOtk,
  sealHandoff,
} from "./handoff.js";

const CRED = utf8("rcp1_THE_VIEWER_PASS_payload_under_handoff");

describe("OTK generation", () => {
  it("generateOtk is 32 bytes and not constant", () => {
    const a = generateOtk();
    const b = generateOtk();
    expect(a.length).toBe(32);
    expect(toHex(a)).not.toBe(toHex(b)); // CSPRNG, astronomically unlikely to collide
  });
});

describe("derived values are domain-separated", () => {
  it("id, claimProof, proofHash are deterministic and mutually distinct", async () => {
    const otk = generateOtk();
    const id1 = await handoffId(otk);
    const id2 = await handoffId(otk);
    expect(toHex(id1)).toBe(toHex(id2)); // deterministic
    expect(id1.length).toBe(32);

    const proof = await handoffClaimProof(otk);
    expect(proof.length).toBe(32);
    expect(toHex(proof)).not.toBe(toHex(id1)); // distinct PRFs of OTK

    const ph = await handoffProofHash(proof);
    expect(ph.length).toBe(32);
    expect(toHex(ph)).not.toBe(toHex(proof)); // server stores the hash, not the proof
    expect(toHex(ph)).not.toBe(toHex(id1));
  });

  it("different OTKs yield different ids/proofs", async () => {
    const a = generateOtk();
    const b = generateOtk();
    expect(toHex(await handoffId(a))).not.toBe(toHex(await handoffId(b)));
    expect(toHex(await handoffClaimProof(a))).not.toBe(toHex(await handoffClaimProof(b)));
  });
});

describe("seal / open round-trip", () => {
  it("opens with the correct OTK", async () => {
    const otk = generateOtk();
    const box = await sealHandoff(otk, CRED);
    expect(box.v).toBe(1);
    expect(box.salt.length).toBe(32);
    expect(box.nonce.length).toBe(12);
    const out = await openHandoff(otk, box);
    expect(toHex(out)).toBe(toHex(CRED));
  });

  it("each seal uses a fresh salt+nonce (ciphertext differs for the same input)", async () => {
    const otk = generateOtk();
    const b1 = await sealHandoff(otk, CRED);
    const b2 = await sealHandoff(otk, CRED);
    expect(toHex(b1.salt)).not.toBe(toHex(b2.salt));
    expect(toHex(b1.nonce)).not.toBe(toHex(b2.nonce));
    expect(toHex(b1.ct)).not.toBe(toHex(b2.ct));
  });

  it("a WRONG OTK fails to open", async () => {
    const otk = generateOtk();
    const box = await sealHandoff(otk, CRED);
    const wrong = generateOtk();
    await expect(openHandoff(wrong, box)).rejects.toMatchObject({ reason: "open-failed" });
  });

  it("a TAMPERED ciphertext fails to open", async () => {
    const otk = generateOtk();
    const box = await sealHandoff(otk, CRED);
    box.ct[0] = ((box.ct[0] ?? 0) ^ 0xff) & 0xff;
    await expect(openHandoff(otk, box)).rejects.toMatchObject({ reason: "open-failed" });
  });

  it("a swapped salt (cross-box substitution) fails to open", async () => {
    const otk = generateOtk();
    const box = await sealHandoff(otk, CRED);
    const other = await sealHandoff(otk, CRED);
    box.salt = other.salt; // salt is AEAD-bound via the derived key → tag mismatch
    await expect(openHandoff(otk, box)).rejects.toMatchObject({ reason: "open-failed" });
  });

  it("an unknown box version is rejected", async () => {
    const otk = generateOtk();
    const box = await sealHandoff(otk, CRED);
    box.v = 2;
    await expect(openHandoff(otk, box)).rejects.toMatchObject({ reason: "bad-version" });
  });

  it("rejects a wrong-size OTK", async () => {
    await expect(sealHandoff(new Uint8Array(16), CRED)).rejects.toMatchObject({
      reason: "bad-length",
    });
  });
});

describe("wire box encode / decode", () => {
  it("round-trips and the decoded box still opens", async () => {
    const otk = generateOtk();
    const box = await sealHandoff(otk, CRED);
    const wire = encodeHandoffBox(box);
    expect(wire.length).toBe(1 + 32 + 12 + box.ct.length);
    const back = decodeHandoffBox(wire);
    expect(back.v).toBe(box.v);
    expect(toHex(back.salt)).toBe(toHex(box.salt));
    expect(toHex(back.nonce)).toBe(toHex(box.nonce));
    expect(toHex(await openHandoff(otk, back))).toBe(toHex(CRED));
  });

  it("rejects a truncated wire box", () => {
    expect(() => decodeHandoffBox(new Uint8Array(10))).toThrow(HandoffError);
  });

  it("encodeHandoffBox is fail-closed (bad version / ct shorter than the GCM tag)", async () => {
    const otk = generateOtk();
    const box = await sealHandoff(otk, CRED);
    expect(() => encodeHandoffBox({ ...box, v: 1.5 })).toThrow(HandoffError);
    expect(() => encodeHandoffBox({ ...box, ct: new Uint8Array(8) })).toThrow(HandoffError);
  });
});

describe("otk1_ codec", () => {
  it("round-trips through format/parse", async () => {
    const otk = generateOtk();
    const s = await formatOtk(otk);
    expect(s.startsWith("otk1_")).toBe(true);
    expect(toHex(await parseOtk(s))).toBe(toHex(otk));
  });

  it("rejects a bad prefix", async () => {
    const otk = generateOtk();
    const s = await formatOtk(otk);
    await expect(parseOtk(s.replace("otk1_", "rcp1_"))).rejects.toMatchObject({
      reason: "bad-prefix",
    });
  });

  it("rejects a bad length", async () => {
    const otk = generateOtk();
    const s = await formatOtk(otk);
    await expect(parseOtk(`${s}x`)).rejects.toMatchObject({ reason: "bad-length" });
  });

  it("rejects a corrupted checksum (one char flipped)", async () => {
    const otk = generateOtk();
    const s = await formatOtk(otk);
    const flipped = s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
    await expect(parseOtk(flipped)).rejects.toMatchObject({ reason: "bad-checksum" });
  });
});
