// Test-only helper (not part of the public surface): assert a captured output stream never
// contains the raw secret in any encoding. The load-bearing zero-knowledge invariant of the
// identity command is that S leaks on exactly one path (the bare token line at creation), so
// every other sink — stderr summaries, --rc-json, --rc-quiet, error messages — is checked.

import { ok } from "node:assert/strict";
import { toHex } from "@remote-claw/clawsec";

/** Throw if `text` contains the rc1_ token, the raw secret hex, or the base64url secret body. */
export function assertNoSecretLeak(text: string, id: { token: string; secret: Uint8Array }): void {
  ok(!text.includes(id.token), "output leaked the rc1_ token");
  ok(!text.includes(toHex(id.secret)), "output leaked the raw secret (hex)");
  // The 43-char base64url(S) body sits between the `rc1_` prefix and the 4-char checksum.
  const body = id.token.slice(4, 47);
  ok(body.length === 43, "expected a 43-char base64url body");
  ok(!text.includes(body), "output leaked the secret body (base64url)");
}
