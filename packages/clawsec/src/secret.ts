// §4.1 secret format: rc1_<base64url(S, 32B, no pad)><4-char Crockford-base32 checksum of
// the top 20 bits of SHA-256(S)>. The checksum fails fast on a mistyped/truncated paste
// before any network call; the 256-bit CSPRNG secret is the actual unguessable credential.

import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { sha256 } from "./bytes.js";
import { crockfordChecksum, normalizeChecksum } from "./checksum.js";

const PREFIX = "rc1_";
const SECRET_BYTES = 32;
const B64_LEN = 43; // base64url of 32 bytes, no padding
const CHECKSUM_LEN = 4; // 4 Crockford chars = 20 bits

export type SecretErrorReason = "bad-prefix" | "bad-length" | "bad-encoding" | "bad-checksum";

export class SecretError extends Error {
  readonly reason: SecretErrorReason;
  constructor(reason: SecretErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "SecretError";
    this.reason = reason;
  }
  static is(e: unknown): e is SecretError {
    return e instanceof SecretError;
  }
}

/** Format a 32-byte secret as an `rc1_…` token. */
export async function formatSecret(secret: Uint8Array): Promise<string> {
  if (secret.length !== SECRET_BYTES) {
    throw new SecretError("bad-length", `secret must be ${SECRET_BYTES} bytes`);
  }
  return PREFIX + base64urlEncode(secret) + crockfordChecksum(await sha256(secret));
}

/** Generate a fresh 256-bit secret and its `rc1_…` token. */
export async function generateSecret(): Promise<{ secret: Uint8Array; token: string }> {
  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return { secret, token: await formatSecret(secret) };
}

/** Parse and validate an `rc1_…` token, returning the 32-byte secret or throwing SecretError. */
export async function parseSecret(token: string): Promise<Uint8Array> {
  if (typeof token !== "string" || !token.startsWith(PREFIX)) {
    throw new SecretError("bad-prefix", "missing rc1_ prefix");
  }
  const body = token.slice(PREFIX.length);
  if (body.length !== B64_LEN + CHECKSUM_LEN) {
    throw new SecretError("bad-length", `expected ${B64_LEN + CHECKSUM_LEN} chars after prefix`);
  }
  const b64 = body.slice(0, B64_LEN);
  const checksum = body.slice(B64_LEN);

  let secret: Uint8Array;
  try {
    secret = base64urlDecode(b64);
  } catch {
    throw new SecretError("bad-encoding", "invalid base64url body");
  }
  if (secret.length !== SECRET_BYTES) {
    throw new SecretError("bad-length", "decoded secret is not 32 bytes");
  }
  // Reject non-canonical encodings (a trailing body char with nonzero unused bits decodes to
  // the same secret), so each secret has exactly one valid token string.
  if (base64urlEncode(secret) !== b64) {
    throw new SecretError("bad-encoding", "non-canonical base64url body");
  }

  const expected = crockfordChecksum(await sha256(secret));
  if (normalizeChecksum(checksum) !== expected) {
    throw new SecretError("bad-checksum", "checksum mismatch (mistyped or truncated?)");
  }
  return secret;
}
