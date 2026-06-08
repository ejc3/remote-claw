// HKDF-SHA256 (RFC 5869) built on WebCrypto HMAC, so Extract and Expand are available
// separately — the §4.2 hierarchy is one Extract(salt=S) then several Expands from the same
// PRK, plus raw Expands for K_session/K_msg, which the one-shot subtle HKDF can't express.

import { concatBytes } from "./bytes.js";

const HASH_LEN = 32; // SHA-256 output

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // An all-zero HashLen key (RFC 5869's default salt) must work even though some HMAC
  // implementations reject a zero-length key; callers pass a non-empty key here.
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

/** RFC 5869 §2.2 — PRK = HMAC-Hash(salt, IKM). Empty salt defaults to HashLen zeros. */
export async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const effectiveSalt = salt.length > 0 ? salt : new Uint8Array(HASH_LEN);
  return hmac(effectiveSalt, ikm);
}

/** RFC 5869 §2.3 — OKM = first `length` bytes of T(1) | T(2) | … where T(i)=HMAC(PRK, T(i-1)|info|i). */
export async function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (length < 0 || length > 255 * HASH_LEN) {
    throw new RangeError(`HKDF-Expand length must be in [0, ${255 * HASH_LEN}]`);
  }
  const n = Math.ceil(length / HASH_LEN);
  const okm = new Uint8Array(n * HASH_LEN);
  let prev: Uint8Array = new Uint8Array(0);
  for (let i = 1; i <= n; i++) {
    prev = await hmac(prk, concatBytes(prev, info, Uint8Array.of(i)));
    okm.set(prev, (i - 1) * HASH_LEN);
  }
  return okm.slice(0, length);
}
