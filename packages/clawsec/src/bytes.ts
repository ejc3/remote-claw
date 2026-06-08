// Small byte helpers shared across the crypto core. WebCrypto + TextEncoder are available
// in Node 22 and browsers.

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string must have even length");
  // Validate up front: Number.parseInt is too lenient (it trims whitespace and stops at the
  // first non-hex char, so "0g" / " 1" / "f-" would parse silently).
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Constant-time byte equality. For equal-length inputs the comparison XOR-accumulates every
 * byte, so its running time does not depend on where the first difference is — denying a
 * timing oracle. WebCrypto exposes no constant-time compare, so the broker's `identity_id`
 * check (§4.2 — recompute `trunc(SHA256(auth_token))`, compare to the requested bus) must use
 * this instead of `===`/`Buffer.equals`. A length mismatch returns `false` immediately: the
 * length itself is not secret (identity_id is a fixed 16 bytes), only the byte values are.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // Both indices are in-bounds, so `?? 0` only satisfies noUncheckedIndexedAccess.
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
