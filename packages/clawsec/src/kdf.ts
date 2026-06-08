// §4.2 / §4.3 key hierarchy. All derived deterministically from the root secret S with
// HKDF-SHA256, identical on CLI host and web client.
//
//   PRK          = HKDF-Extract(salt="remote-claw/v1", IKM=S)
//   auth_token   = HKDF-Expand(PRK, "remote-claw/v1/auth",        32)
//   identity_id  = trunc(SHA256(auth_token), 16)        ← public, broker self-verifies bearer
//   content_root = HKDF-Expand(PRK, "remote-claw/v1/content",     32)  (client-only)
//   control_key  = HKDF-Expand(PRK, "remote-claw/v1/control",     32)
//   K_meta       = HKDF-Expand(PRK, "remote-claw/v1/meta-frame",  32)
//   K_session    = HKDF-Expand(content_root, "session:"+session_id, 32)

import { sha256, utf8 } from "./bytes.js";
import { hkdfExpand, hkdfExtract } from "./hkdf.js";

const ROOT_SALT = utf8("remote-claw/v1");
const KEY_LEN = 32;
const IDENTITY_ID_LEN = 16;

export interface Identity {
  /** Bearer presented to the Vercel API (authorization, not confidentiality). */
  authToken: Uint8Array;
  /** Public 16-byte id = trunc(SHA256(authToken)); the broker recomputes it to self-verify. */
  identityId: Uint8Array;
  /** Client-only master content key; K_session is derived from it per session. */
  contentRoot: Uint8Array;
  /** AEAD key for control-plane frames (dir:in). */
  controlKey: Uint8Array;
  /** AEAD key for meta frames (accepted / session_announce). */
  kMeta: Uint8Array;
}

/** Derive the full per-identity key set from the 32-byte root secret. */
export async function deriveIdentity(secret: Uint8Array): Promise<Identity> {
  const prk = await hkdfExtract(ROOT_SALT, secret);
  const authToken = await hkdfExpand(prk, utf8("remote-claw/v1/auth"), KEY_LEN);
  const identityId = (await sha256(authToken)).slice(0, IDENTITY_ID_LEN);
  const contentRoot = await hkdfExpand(prk, utf8("remote-claw/v1/content"), KEY_LEN);
  const controlKey = await hkdfExpand(prk, utf8("remote-claw/v1/control"), KEY_LEN);
  const kMeta = await hkdfExpand(prk, utf8("remote-claw/v1/meta-frame"), KEY_LEN);
  return { authToken, identityId, contentRoot, controlKey, kMeta };
}

/** Derive a session's content key from content_root (§4.3). */
export async function deriveSessionKey(
  contentRoot: Uint8Array,
  sessionId: string,
): Promise<Uint8Array> {
  return hkdfExpand(contentRoot, utf8(`session:${sessionId}`), KEY_LEN);
}
