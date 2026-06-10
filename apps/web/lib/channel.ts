import { busToken, sessionToken } from "@remote-claw/clawsec";

// The channel token derivation (§6A) — pure, backend-independent, shared by both broker routes. The
// 16-byte identity + an optional session id selects the channel: the per-identity BUS, or a
// per-session stream. The resume-or-start handshake and stream resolution that used to live here are
// now the backend's job (lib/broker/*), so a token can address a Vercel run, a LocalBackend channel,
// or a Temporal workflow without the routes caring which.

/** The 16-byte identity + an optional session id selects the channel: bus, or per-session stream. */
export function channelToken(identityId: Uint8Array, sessionId: string | null): string {
  return sessionId === null ? busToken(identityId) : sessionToken(identityId, sessionId);
}
