import { fromHex, sha256 } from "@remote-claw/clawsec";

// §4.2/§4.5 admission gate. Every identity-scoped data/recovery request carries
// `Authorization: Bearer <hex(auth_token)>`
// (hex, like identity_id and the rest of the routing surface — no second encoding to drift). The
// broker RECOMPUTES `identity_id = trunc(SHA256(auth_token), 16)` from the bearer and routes by
// THAT — never by a client-supplied id. Because identity_id is a one-way function of auth_token, a
// caller can only ever address the identity whose auth_token they hold; the unguessable 128-bit
// identity_id + required token is the whole anti-scanning gate (no stored hash, no app-key). This is
// admission only — confidentiality/integrity stay with the content keys the broker never sees.

const AUTH_TOKEN_LEN = 32;
const IDENTITY_ID_LEN = 16;
const BEARER = /^Bearer (.+)$/;

/** A request that failed admission; `status` is the HTTP code the route should return. */
export class AuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
  static is(e: unknown): e is AuthError {
    return e instanceof AuthError;
  }
}

/**
 * Recompute the caller's 16-byte identity_id from `Authorization: Bearer <hex(auth_token)>`.
 * Throws AuthError (→ 401) when the header is missing/malformed or the token isn't 32 bytes. The
 * returned id is the ONLY identity this request may address.
 */
export async function identityFromRequest(req: Request): Promise<Uint8Array> {
  const header = req.headers.get("authorization");
  if (header === null) throw new AuthError("missing Authorization header");
  const m = BEARER.exec(header);
  if (m === null) throw new AuthError("Authorization must be: Bearer <token>");
  // m[1] is the token group; it always exists when the regex matches.
  const tokenStr = m[1] as string;
  let authToken: Uint8Array;
  try {
    authToken = fromHex(tokenStr);
  } catch {
    throw new AuthError("bearer token is not valid hex");
  }
  if (authToken.length !== AUTH_TOKEN_LEN) {
    throw new AuthError(`bearer token must decode to ${AUTH_TOKEN_LEN} bytes`);
  }
  return (await sha256(authToken)).slice(0, IDENTITY_ID_LEN);
}
