// @remote-claw/clawsec — the crypto core. Public surface grows one unit per PR.
export { fromHex, sha256, timingSafeEqual, toHex, utf8 } from "./bytes.js";
export { hkdfExpand, hkdfExtract } from "./hkdf.js";
export { deriveIdentity, deriveSessionKey, type Identity } from "./kdf.js";
export {
  formatSecret,
  generateSecret,
  normalizeChecksum,
  parseSecret,
  SecretError,
  type SecretErrorReason,
} from "./secret.js";
