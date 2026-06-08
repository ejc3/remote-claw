// §4.1 secret format: rc1_<base64url(S, 32B, no pad)><4-char Crockford-base32 checksum of
// the top 20 bits of SHA-256(S)>. The checksum fails fast on a mistyped/truncated paste
// before any network call; the 256-bit CSPRNG secret is the actual unguessable credential.

import { base64urlDecode, base64urlEncode } from "./base64url.js";

const PREFIX = "rc1_";
const SECRET_BYTES = 32;
const B64_LEN = 43; // base64url of 32 bytes, no padding
const CHECKSUM_LEN = 4; // 4 Crockford chars = 20 bits
// Crockford base32 alphabet (excludes I, L, O, U to avoid transcription ambiguity).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** 4 Crockford-base32 chars encoding the top 20 bits of the digest. */
function checksumOf(digest: Uint8Array): string {
  const b0 = digest[0] ?? 0;
  const b1 = digest[1] ?? 0;
  const b2 = digest[2] ?? 0;
  const bits = (b0 << 12) | (b1 << 4) | (b2 >> 4); // top 20 bits
  // Each shift is masked to [0,31], so CROCKFORD[i] is always defined; `?? ""` only
  // satisfies noUncheckedIndexedAccess and never actually fires.
  return [(bits >> 15) & 31, (bits >> 10) & 31, (bits >> 5) & 31, bits & 31]
    .map((i) => CROCKFORD[i] ?? "")
    .join("");
}

/** Crockford transcription tolerance: O→0, I/L→1, case-insensitive. */
export function normalizeChecksum(s: string): string {
  return s.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Format a 32-byte secret as an `rc1_…` token. */
export async function formatSecret(secret: Uint8Array): Promise<string> {
  if (secret.length !== SECRET_BYTES) {
    throw new SecretError("bad-length", `secret must be ${SECRET_BYTES} bytes`);
  }
  return PREFIX + base64urlEncode(secret) + checksumOf(await sha256(secret));
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

  const expected = checksumOf(await sha256(secret));
  if (normalizeChecksum(checksum) !== expected) {
    throw new SecretError("bad-checksum", "checksum mismatch (mistyped or truncated?)");
  }
  return secret;
}
