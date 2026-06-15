import { AttachmentTooLargeError } from "./viewer";

/** Translate a send/attach failure into an actionable line for the composer. A transport failure —
 *  including an edge body-size rejection (Vercel FUNCTION_PAYLOAD_TOO_LARGE) — surfaces as a bare
 *  "Load failed" on WebKit / "Failed to fetch" on Chromium, neither of which tells the user what to do.
 *  An oversized attachment is caught before the network and explained as such. */
export function friendlySendError(e: unknown): string {
  if (e instanceof AttachmentTooLargeError)
    return "that image is too large to send — try a smaller one";
  const msg = e instanceof Error ? e.message : String(e);
  // A too-large body that slipped past the client guard: either the broker's deterministic 413
  // ("broker 413: …ciphertext exceeds the relay size cap") or the platform's own "payload too large".
  // Map it to the same clear line rather than showing the raw broker/HTTP text.
  if (/\b413\b|payload too large|ciphertext exceeds|entity too large/i.test(msg))
    return "that's too large to send — try a smaller image";
  // A transport failure (incl. the platform edge cutting an oversized upload mid-flight) surfaces as a
  // bare "Load failed" (WebKit) / "Failed to fetch" (Chromium) — neither tells the user what to do.
  if (/load failed|failed to fetch|network\s*error/i.test(msg))
    return "the connection dropped — check your network and try again";
  return msg;
}
