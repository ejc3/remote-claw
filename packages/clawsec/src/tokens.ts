// §6A/§6B channel tokens. A channel is named by a CLIENT-DERIVABLE token — no stored pointer:
// the per-identity bus is `bus:presence-v2:${identity_id}`; a per-session stream is
// `sess:${identity_id}:${session_id}`. The host, the broker, and the web client all derive the
// same string from the same public inputs, so a value-addressed `getHookByToken(token)` resolves
// the run without any lookup table (§6B "It's value-addressed — no stored pointer").

import { toHex } from "./bytes.js";

/**
 * True if `s` holds an ASCII control char (0x00–0x1f or DEL 0x7f). Checked by code point so the
 * source stays clean ASCII (no literal control bytes in a regex). A control char in a session id
 * would let it smuggle a newline/NUL into the routing label the broker logs and routes on.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** The 16-byte identity id, rendered as the lowercase-hex string used inside channel tokens. */
export function identityHex(identityId: Uint8Array): string {
  if (identityId.length !== 16) {
    throw new RangeError(`identityId must be 16 bytes, got ${identityId.length}`);
  }
  return toHex(identityId);
}

/** The per-identity bus channel (discovery + absorbing presence lifecycle).
 *
 * `presence-v2` is a deployment fence as well as a namespace version: an already-running Workflow
 * is pinned to the code that created it, so changing the token starts a fresh run whose relay knows
 * how to absorb `session_terminal` before any v2 presence can be published. */
export function busToken(identityId: Uint8Array): string {
  return `bus:presence-v2:${identityHex(identityId)}`;
}

/**
 * A per-session stream channel: `sess:${identity_id}:${session_id}` (§6A). `session_id` is a
 * claude session id (a UUID — no colons), appended verbatim so host and client derive the same
 * token; it is rejected if empty or carrying an ASCII control char.
 */
export function sessionToken(identityId: Uint8Array, sessionId: string): string {
  if (sessionId.length === 0) throw new RangeError("sessionId must be non-empty");
  if (hasControlChar(sessionId)) {
    throw new RangeError("sessionId must not contain ASCII control characters");
  }
  return `sess:${identityHex(identityId)}:${sessionId}`;
}
