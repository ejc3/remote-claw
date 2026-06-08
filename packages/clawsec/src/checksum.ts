// Crockford-base32 checksum shared by the `rc1_` secret (§4.1) and the `rcp1_` pass (§4.2a)
// formats: 4 chars encoding the top 20 bits of a SHA-256 digest, so a mistyped/truncated paste
// fails fast before any network call.

// Crockford base32 alphabet (excludes I, L, O, U to avoid transcription ambiguity).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 4 Crockford-base32 chars encoding the top 20 bits of `digest`. */
export function crockfordChecksum(digest: Uint8Array): string {
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
