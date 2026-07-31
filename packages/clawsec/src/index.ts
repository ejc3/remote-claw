// @remote-claw/clawsec — the crypto core. Public surface grows one unit per PR.
export { canonicalAad, type Dir, type FrameHeader } from "./aad.js";
export { AeadError, type Frame, open, seal } from "./aead.js";
export { base64urlDecode, base64urlEncode } from "./base64url.js";
export { concatBytes, fromHex, sha256, timingSafeEqual, toHex, utf8 } from "./bytes.js";
export { CanonicalWriter, canonicalByteSnapshot } from "./canonical.js";
export { normalizeChecksum } from "./checksum.js";
export {
  ChunkError,
  type ChunkHeader,
  openChunked,
  sealChunked,
  splitPlaintext,
} from "./chunk.js";
export {
  decodeHandoffBox,
  encodeHandoffBox,
  formatOtk,
  generateOtk,
  type HandoffBox,
  HandoffError,
  type HandoffErrorReason,
  handoffClaimProof,
  handoffId,
  handoffProofHash,
  openHandoff,
  parseOtk,
  sealHandoff,
} from "./handoff.js";
export { hkdfExpand, hkdfExtract } from "./hkdf.js";
export { deriveIdentity, deriveSessionKey, type Identity } from "./kdf.js";
export { formatPass, PassError, type PassErrorReason, parsePass } from "./pass.js";
export {
  formatSecret,
  generateSecret,
  parseSecret,
  SecretError,
  type SecretErrorReason,
} from "./secret.js";
export { busToken, identityHex, sessionToken } from "./tokens.js";
export { decodeFrame, encodeFrame, WireError, type WireFrame } from "./wire.js";
