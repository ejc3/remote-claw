import { describe, expect, it } from "vitest";
import { newDeviceKey, unwrapPass, wrapPass } from "../app/lib/credential-store";

// The security-relevant crypto core (§3.6). The IndexedDB + sessionStorage glue is browser-only and thin;
// here we prove the non-extractable device key + wrap/unwrap behave (WebCrypto is available in node).
describe("credential-store crypto core", () => {
  it("wrap → unwrap round-trips under the device key", async () => {
    const key = await newDeviceKey();
    const blob = await wrapPass("rcp1_SECRET_PASS", key);
    expect(blob.iv.length).toBe(12);
    expect(blob.ct.length).toBeGreaterThan(16); // ciphertext includes the 16-byte GCM tag
    expect(await unwrapPass(blob, key)).toBe("rcp1_SECRET_PASS");
  });

  it("the device key is NON-EXTRACTABLE — exportKey throws (bytes can't be exfiltrated)", async () => {
    const key = await newDeviceKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("a different device key cannot unwrap (no cross-key decrypt)", async () => {
    const a = await newDeviceKey();
    const b = await newDeviceKey();
    const blob = await wrapPass("rcp1_X", a);
    await expect(unwrapPass(blob, b)).rejects.toThrow();
  });

  it("each wrap uses a fresh iv (ciphertext differs for the same pass)", async () => {
    const key = await newDeviceKey();
    const a = await wrapPass("rcp1_X", key);
    const b = await wrapPass("rcp1_X", key);
    expect(Buffer.from(a.iv).toString("hex")).not.toBe(Buffer.from(b.iv).toString("hex"));
    expect(Buffer.from(a.ct).toString("hex")).not.toBe(Buffer.from(b.ct).toString("hex"));
  });

  it("tampered ciphertext fails to unwrap", async () => {
    const key = await newDeviceKey();
    const blob = await wrapPass("rcp1_X", key);
    blob.ct[0] = (blob.ct[0] ?? 0) ^ 0xff;
    await expect(unwrapPass(blob, key)).rejects.toThrow();
  });
});
