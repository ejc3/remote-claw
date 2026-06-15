// Ephemeral one-time credential handoff (OTK) — the crypto half. See docs/ephemeral-handoff.md.
//
// The host mints a 256-bit OTK, seals a credential under a key derived from it, and uploads the sealed box
// to a zero-knowledge server index keyed by a HASH of the OTK; the QR carries only the OTK (in the URL
// #fragment). The viewer presents a HASH of the OTK + a proof-of-OTK, the server atomically returns-and-burns
// the box, and the viewer opens it locally with the OTK. The server only ever sees one-way hashes + a blob it
// cannot read.
//
// Three DOMAIN-SEPARATED values are derived from one OTK (§3.1):
//   id          = SHA256(OTK)                                          — public lookup key (bare unkeyed hash)
//   wrapKey     = HKDF-Expand(HKDF-Extract("remote-claw/v1", OTK), "remote-claw/v1/handoff-wrap",  32)
//   claimProof  = HKDF-Expand(HKDF-Extract("remote-claw/v1", OTK), "remote-claw/v1/handoff-claim", 32)
// `id` is a bare SHA-256 while wrapKey/claimProof are HMAC-keyed HKDF outputs — DISTINCT PRFs of the OTK, so
// the public `id` is computationally independent of the key and the proof (an observer of `id` learns nothing
// about either). The server stores SHA256(claimProof) (NOT the proof), so an observer of `id` alone — e.g. a
// TLS-terminating edge or a log — cannot burn or claim the row (it needs the OTK to compute the proof).
//
// The box is AES-256-GCM with a fresh per-box HKDF salt + nonce (mirroring aead.ts), AAD-bound to the format
// version and `id` so a malicious server cannot serve the blob stored under a different id (substitution).
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { concatBytes, sha256, utf8 } from "./bytes.js";
import { crockfordChecksum, normalizeChecksum } from "./checksum.js";
import { hkdfExpand, hkdfExtract } from "./hkdf.js";

const ROOT_SALT = utf8("remote-claw/v1");
const WRAP_INFO = utf8("remote-claw/v1/handoff-wrap");
const CLAIM_INFO = utf8("remote-claw/v1/handoff-claim");
const BOX_MSG_INFO = utf8("remote-claw/v1/handoff-msg");
const AAD_PREFIX = utf8("rc-handoff/v1"); // version-bound into the AEAD AAD

const OTK_LEN = 32; // 256-bit CSPRNG
const KEY_LEN = 32;
const SALT_LEN = 32;
const NONCE_LEN = 12;
const TAG_BITS = 128;
const BOX_V = 1;

const PREFIX = "otk1_";
const B64_LEN = base64urlEncode(new Uint8Array(OTK_LEN)).length; // 43 for 32 bytes, no padding
const CHECKSUM_LEN = 4;

export type HandoffErrorReason =
  | "bad-prefix"
  | "bad-length"
  | "bad-encoding"
  | "bad-checksum"
  | "bad-version"
  | "open-failed";

export class HandoffError extends Error {
  readonly reason: HandoffErrorReason;
  constructor(reason: HandoffErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "HandoffError";
    this.reason = reason;
  }
  static is(e: unknown): e is HandoffError {
    return e instanceof HandoffError;
  }
}

/** The sealed handoff envelope. `v`/`salt`/`nonce` are cleartext framing; `ct` is the AES-GCM output incl.
 *  the 16-byte tag. The server stores the wire-encoded box (encodeHandoffBox) verbatim and cannot read it. */
export interface HandoffBox {
  v: number;
  salt: Uint8Array;
  nonce: Uint8Array;
  ct: Uint8Array;
}

/** A fresh 256-bit OTK from the platform CSPRNG. */
export function generateOtk(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(OTK_LEN));
}

function assertOtk(otk: Uint8Array): void {
  if (otk.length !== OTK_LEN) throw new HandoffError("bad-length", `OTK must be ${OTK_LEN} bytes`);
}

/** The public lookup id for an OTK — `SHA256(OTK)` (32 bytes). Safe to send to the server. */
export function handoffId(otk: Uint8Array): Promise<Uint8Array> {
  assertOtk(otk);
  return sha256(otk);
}

/** The consume capability — `HKDF(OTK, "handoff-claim")`. The viewer presents this on claim; the server
 *  stores only `handoffProofHash(claimProof)` and compares, so seeing `id` alone cannot burn the row. */
export async function handoffClaimProof(otk: Uint8Array): Promise<Uint8Array> {
  assertOtk(otk);
  const prk = await hkdfExtract(ROOT_SALT, otk);
  return hkdfExpand(prk, CLAIM_INFO, KEY_LEN);
}

/** What the server stores to verify a presented claim proof — `SHA256(claimProof)` (never the proof). */
export function handoffProofHash(claimProof: Uint8Array): Promise<Uint8Array> {
  return sha256(claimProof);
}

async function wrapKey(otk: Uint8Array): Promise<Uint8Array> {
  const prk = await hkdfExtract(ROOT_SALT, otk);
  return hkdfExpand(prk, WRAP_INFO, KEY_LEN);
}

/** Per-box AAD: the version prefix bound to the box's id, so a server cannot serve box B's ciphertext for a
 *  claim of id A (the GCM tag fails). */
function boxAad(id: Uint8Array): Uint8Array {
  return concatBytes(AAD_PREFIX, id);
}

async function deriveBoxKey(wk: Uint8Array, salt: Uint8Array, aad: Uint8Array): Promise<CryptoKey> {
  const prk = await hkdfExtract(salt, wk);
  const kMsg = await hkdfExpand(prk, concatBytes(BOX_MSG_INFO, aad), KEY_LEN);
  return crypto.subtle.importKey("raw", kMsg as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Seal `plaintext` (the credential material) into a one-time handoff box for `otk`. */
export async function sealHandoff(otk: Uint8Array, plaintext: Uint8Array): Promise<HandoffBox> {
  assertOtk(otk);
  const id = await sha256(otk);
  const aad = boxAad(id);
  const wk = await wrapKey(otk);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const key = await deriveBoxKey(wk, salt, aad);
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: TAG_BITS,
    },
    key,
    plaintext as BufferSource,
  );
  return { v: BOX_V, salt, nonce, ct: new Uint8Array(ct) };
}

/** Open a handoff box with `otk`, returning the plaintext. Throws HandoffError on any auth/format failure. */
export async function openHandoff(otk: Uint8Array, box: HandoffBox): Promise<Uint8Array> {
  assertOtk(otk);
  if (box.v !== BOX_V) throw new HandoffError("bad-version", `unsupported box version ${box.v}`);
  if (box.salt.length !== SALT_LEN)
    throw new HandoffError("bad-length", `salt must be ${SALT_LEN} bytes`);
  if (box.nonce.length !== NONCE_LEN) {
    throw new HandoffError("bad-length", `nonce must be ${NONCE_LEN} bytes`);
  }
  const id = await sha256(otk);
  const aad = boxAad(id);
  const wk = await wrapKey(otk);
  const key = await deriveBoxKey(wk, box.salt, aad);
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: box.nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: TAG_BITS,
      },
      key,
      box.ct as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    throw new HandoffError(
      "open-failed",
      "handoff box authentication failed (wrong OTK or tampered)",
    );
  }
}

/** Wire-encode a box for transport/storage: `v(1) ‖ salt(32) ‖ nonce(12) ‖ ct`. */
export function encodeHandoffBox(box: HandoffBox): Uint8Array {
  if (!Number.isInteger(box.v) || box.v < 0 || box.v > 255) {
    throw new HandoffError("bad-version", "box version must be an integer in [0,255]");
  }
  if (box.salt.length !== SALT_LEN || box.nonce.length !== NONCE_LEN) {
    throw new HandoffError("bad-length", "salt/nonce wrong size");
  }
  if (box.ct.length < TAG_BITS / 8) {
    throw new HandoffError("bad-length", "ciphertext shorter than the GCM tag");
  }
  return concatBytes(new Uint8Array([box.v]), box.salt, box.nonce, box.ct);
}

/** Decode a wire box; throws on a truncated/short buffer. */
export function decodeHandoffBox(bytes: Uint8Array): HandoffBox {
  const min = 1 + SALT_LEN + NONCE_LEN + TAG_BITS / 8; // a valid GCM ct is at least the tag
  if (bytes.length < min) throw new HandoffError("bad-length", "handoff box too short");
  let o = 0;
  const v = bytes[o];
  o += 1;
  const salt = bytes.slice(o, o + SALT_LEN);
  o += SALT_LEN;
  const nonce = bytes.slice(o, o + NONCE_LEN);
  o += NONCE_LEN;
  const ct = bytes.slice(o);
  return { v: v ?? -1, salt, nonce, ct };
}

/** Serialize the OTK for the QR/#fragment: `otk1_<base64url(OTK)><4-char Crockford checksum of SHA256(OTK)>`.
 *  Mirrors pass.ts so a truncated/garbled scan fails closed. */
export async function formatOtk(otk: Uint8Array): Promise<string> {
  assertOtk(otk);
  return PREFIX + base64urlEncode(otk) + crockfordChecksum(await sha256(otk));
}

/** Parse + validate an `otk1_…` string, returning the raw OTK. Throws HandoffError on prefix/length/encoding/
 *  checksum mismatch (so a mistyped/truncated fragment never yields a wrong-but-accepted OTK). */
export async function parseOtk(token: string): Promise<Uint8Array> {
  if (typeof token !== "string" || !token.startsWith(PREFIX)) {
    throw new HandoffError("bad-prefix", "missing otk1_ prefix");
  }
  const body = token.slice(PREFIX.length);
  if (body.length !== B64_LEN + CHECKSUM_LEN) {
    throw new HandoffError("bad-length", `expected ${B64_LEN + CHECKSUM_LEN} chars after prefix`);
  }
  const b64 = body.slice(0, B64_LEN);
  const checksum = body.slice(B64_LEN);
  let otk: Uint8Array;
  try {
    otk = base64urlDecode(b64);
  } catch {
    throw new HandoffError("bad-encoding", "invalid base64url body");
  }
  if (otk.length !== OTK_LEN)
    throw new HandoffError("bad-length", `decoded OTK is not ${OTK_LEN} bytes`);
  if (base64urlEncode(otk) !== b64)
    throw new HandoffError("bad-encoding", "non-canonical base64url body");
  if (normalizeChecksum(checksum) !== crockfordChecksum(await sha256(otk))) {
    throw new HandoffError("bad-checksum", "checksum mismatch (mistyped or truncated?)");
  }
  return otk;
}
