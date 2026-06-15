import { AttachmentTooLargeError } from "./viewer";

/** Translate a send/attach failure into an actionable line for the composer. A transport failure —
 *  including an edge body-size rejection (Vercel FUNCTION_PAYLOAD_TOO_LARGE) — surfaces as a bare
 *  "Load failed" on WebKit / "Failed to fetch" on Chromium, neither of which tells the user what to do.
 *  An oversized attachment is caught before the network and explained as such. */
export function friendlySendError(e: unknown): string {
  if (e instanceof AttachmentTooLargeError)
    return "that image is too large to send — try a smaller one";
  const msg = e instanceof Error ? e.message : String(e);
  if (/load failed|failed to fetch|network\s*error/i.test(msg))
    return "the connection dropped — check your network and try again";
  return msg;
}
