// §4.3 / §8 AEAD plane. Each message gets a fresh per-message subkey
//   K_msg = HKDF(salt = random 32B, IKM = planeKey, info = "remote-claw/v1/msg" || canonical_AAD)
// then ct = AES-256-GCM(K_msg, nonce = random 12B, AAD = canonical_AAD). The random per-message
// salt makes K_msg independent per message, so stateless multi-device senders can't trigger a
// catastrophic GCM (key,nonce) reuse (§4.3). The same scheme covers all three planes — the
// caller passes K_session, control_key, or K_meta as `planeKey`. (planeKey is the HKDF IKM and
// may be any length; in this system it is always a 32-byte derived key.)

import { canonicalAad, type FrameHeader } from "./aad.js";
import { concatBytes, utf8 } from "./bytes.js";
import { canonicalByteSnapshot } from "./canonical.js";
import { hkdfExpand, hkdfExtract } from "./hkdf.js";

const MSG_INFO = utf8("remote-claw/v1/msg");
const SALT_LEN = 32;
const NONCE_LEN = 12;
const KEY_LEN = 32;
const TAG_BITS = 128;

function snapshotBytes(value: Uint8Array): Uint8Array {
  return canonicalByteSnapshot(value);
}

function snapshotHeader(header: FrameHeader): FrameHeader {
  const {
    v,
    identityId,
    sessionId,
    dir,
    recordKind,
    seq,
    msgId,
    clientMsgId,
    keyEpoch,
    part,
    parts,
  } = header;
  const snapshot: FrameHeader = {
    v,
    identityId: snapshotBytes(identityId),
    sessionId,
    dir,
    recordKind,
    seq,
    msgId,
    keyEpoch,
    part,
    parts,
  };
  if (clientMsgId !== undefined) snapshot.clientMsgId = clientMsgId;
  return snapshot;
}

/** The §8 wire frame: the header fields + the per-message salt/nonce + ciphertext (incl. tag). */
export interface Frame extends FrameHeader {
  salt: Uint8Array; // 32-byte HKDF salt for K_msg
  nonce: Uint8Array; // 12-byte AES-GCM nonce
  ct: Uint8Array; // ciphertext including the 16-byte GCM tag
}

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AeadError";
  }
  static is(e: unknown): e is AeadError {
    return e instanceof AeadError;
  }
}

async function deriveMsgKey(
  planeKey: Uint8Array,
  salt: Uint8Array,
  aad: Uint8Array,
): Promise<CryptoKey> {
  const prk = await hkdfExtract(salt, planeKey);
  const kMsg = await hkdfExpand(prk, concatBytes(MSG_INFO, aad), KEY_LEN);
  return crypto.subtle.importKey("raw", kMsg as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Seal with a caller-supplied salt and nonce. **Internal / advanced** — the caller MUST
 * guarantee the (salt, nonce) pair is unique for this planeKey. `seal()` is the safe entry
 * point; this exists so tests can pin deterministic vectors. Not part of the package's public
 * surface (not re-exported from index).
 */
export async function sealWith(
  planeKey: Uint8Array,
  header: FrameHeader,
  plaintext: Uint8Array,
  salt: Uint8Array,
  nonce: Uint8Array,
): Promise<Frame> {
  const headerSnapshot = snapshotHeader(header);
  const planeKeySnapshot = snapshotBytes(planeKey);
  const plaintextSnapshot = snapshotBytes(plaintext);
  const saltSnapshot = snapshotBytes(salt);
  const nonceSnapshot = snapshotBytes(nonce);
  if (saltSnapshot.length !== SALT_LEN) throw new AeadError(`salt must be ${SALT_LEN} bytes`);
  if (nonceSnapshot.length !== NONCE_LEN) throw new AeadError(`nonce must be ${NONCE_LEN} bytes`);
  const aad = canonicalAad(headerSnapshot);
  const key = await deriveMsgKey(planeKeySnapshot, saltSnapshot, aad);
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonceSnapshot as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: TAG_BITS,
    },
    key,
    plaintextSnapshot as BufferSource,
  );
  return { ...headerSnapshot, salt: saltSnapshot, nonce: nonceSnapshot, ct: new Uint8Array(ct) };
}

/** Seal a plaintext into a Frame with a fresh random salt + nonce (§4.3). */
export async function seal(
  planeKey: Uint8Array,
  header: FrameHeader,
  plaintext: Uint8Array,
): Promise<Frame> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  return sealWith(planeKey, header, plaintext, salt, nonce);
}

/** Open a Frame, returning the plaintext or throwing AeadError on any authentication failure. */
export async function open(planeKey: Uint8Array, frame: Frame): Promise<Uint8Array> {
  const header = snapshotHeader(frame);
  const planeKeySnapshot = snapshotBytes(planeKey);
  const salt = snapshotBytes(frame.salt);
  const nonce = snapshotBytes(frame.nonce);
  const ct = snapshotBytes(frame.ct);
  if (salt.length !== SALT_LEN) throw new AeadError(`salt must be ${SALT_LEN} bytes`);
  if (nonce.length !== NONCE_LEN) throw new AeadError(`nonce must be ${NONCE_LEN} bytes`);
  const aad = canonicalAad(header);
  const key = await deriveMsgKey(planeKeySnapshot, salt, aad);
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: TAG_BITS,
      },
      key,
      ct as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    throw new AeadError(
      "AEAD authentication failed (tampered ciphertext, wrong key, or wrong header/AAD)",
    );
  }
}
