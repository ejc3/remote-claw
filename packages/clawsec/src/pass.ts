// §4.2a the pass: a viewer credential = the derived key bundle {authToken, contentRoot,
// controlKey, kMeta} WITHOUT the root secret S. The secret derives these (HKDF-SHA256, one-way),
// so a pass can NOT be inverted back to S nor re-mint identity_id; it grants read + steer of ONE
// machine (and, because the content/control/meta keys are symmetric, can also produce valid frames
// for that machine — the boundary a pass draws is possession of S, not write-vs-read). There is no
// in-place pass revocation: reset moves future service but retained old routes accept copied passes.
//
// Format: rcp1_<base64url(authToken||contentRoot||controlKey||kMeta, 128B, no pad)><4-char
// Crockford checksum of SHA-256(payload)>. QR/file-sized, not hand-typed. identity_id is NOT
// stored — it is recomputed from authToken on parse, so a pass has exactly one valid string.

import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { sha256 } from "./bytes.js";
import { crockfordChecksum, normalizeChecksum } from "./checksum.js";
import type { Identity } from "./kdf.js";

const PREFIX = "rcp1_";
const KEY_LEN = 32;
const IDENTITY_ID_LEN = 16;
const PASS_BYTES = 4 * KEY_LEN; // authToken | contentRoot | controlKey | kMeta = 128
const B64_LEN = 171; // base64url of 128 bytes, no padding
const CHECKSUM_LEN = 4;

export type PassErrorReason = "bad-prefix" | "bad-length" | "bad-encoding" | "bad-checksum";

export class PassError extends Error {
  readonly reason: PassErrorReason;
  constructor(reason: PassErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "PassError";
    this.reason = reason;
  }
  static is(e: unknown): e is PassError {
    return e instanceof PassError;
  }
}

function assertKey(name: string, k: Uint8Array): void {
  if (k.length !== KEY_LEN) {
    throw new PassError("bad-length", `${name} must be ${KEY_LEN} bytes`);
  }
}

/**
 * Serialize an identity's operational keys as an `rcp1_…` pass. The root secret is NOT part of a
 * pass (it never enters here), and identity_id is omitted (it is a function of authToken).
 */
export async function formatPass(identity: Identity): Promise<string> {
  assertKey("authToken", identity.authToken);
  assertKey("contentRoot", identity.contentRoot);
  assertKey("controlKey", identity.controlKey);
  assertKey("kMeta", identity.kMeta);
  const payload = new Uint8Array(PASS_BYTES);
  payload.set(identity.authToken, 0);
  payload.set(identity.contentRoot, KEY_LEN);
  payload.set(identity.controlKey, 2 * KEY_LEN);
  payload.set(identity.kMeta, 3 * KEY_LEN);
  return PREFIX + base64urlEncode(payload) + crockfordChecksum(await sha256(payload));
}

/**
 * Parse + validate an `rcp1_…` pass, returning the Identity with identity_id recomputed from
 * authToken (so it self-verifies against the broker exactly like the secret-derived identity).
 * Throws PassError on a bad prefix / length / encoding / checksum.
 */
export async function parsePass(token: string): Promise<Identity> {
  if (typeof token !== "string" || !token.startsWith(PREFIX)) {
    throw new PassError("bad-prefix", "missing rcp1_ prefix");
  }
  const body = token.slice(PREFIX.length);
  if (body.length !== B64_LEN + CHECKSUM_LEN) {
    throw new PassError("bad-length", `expected ${B64_LEN + CHECKSUM_LEN} chars after prefix`);
  }
  const b64 = body.slice(0, B64_LEN);
  const checksum = body.slice(B64_LEN);

  let payload: Uint8Array;
  try {
    payload = base64urlDecode(b64);
  } catch {
    throw new PassError("bad-encoding", "invalid base64url body");
  }
  if (payload.length !== PASS_BYTES) {
    throw new PassError("bad-length", `decoded pass is not ${PASS_BYTES} bytes`);
  }
  // Reject non-canonical encodings (trailing unused bits) so each pass has exactly one token.
  if (base64urlEncode(payload) !== b64) {
    throw new PassError("bad-encoding", "non-canonical base64url body");
  }
  if (normalizeChecksum(checksum) !== crockfordChecksum(await sha256(payload))) {
    throw new PassError("bad-checksum", "checksum mismatch (mistyped or truncated?)");
  }

  const authToken = payload.slice(0, KEY_LEN);
  const contentRoot = payload.slice(KEY_LEN, 2 * KEY_LEN);
  const controlKey = payload.slice(2 * KEY_LEN, 3 * KEY_LEN);
  const kMeta = payload.slice(3 * KEY_LEN, 4 * KEY_LEN);
  const identityId = (await sha256(authToken)).slice(0, IDENTITY_ID_LEN);
  return { authToken, identityId, contentRoot, controlKey, kMeta };
}
