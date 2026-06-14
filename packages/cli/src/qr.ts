// QR rendering for `--rc-pass --rc-qr` — a presentation helper, NOT crypto (the pass it encodes is
// already the clawsec viewer credential). The pass was designed to be "QR/file-sized" (pass.ts §4.2a);
// this renders it as a compact terminal QR so a phone can scan it.
import qrcodeTerminal from "qrcode-terminal";

/**
 * The payload to encode in the pass QR. With an app origin (the `--rc-app`/RC_APP web origin), build the
 * viewer DEEP LINK `<origin>/#<pass>` — the web app reads the pass from the URL fragment (never sent to a
 * server), so scanning opens the viewer already loaded. Without an origin (or a malformed one), encode the
 * BARE pass for manual entry. The pass is base64url + an `rcp1_` prefix — all URL-fragment-safe, so it
 * needs no percent-encoding.
 */
export function passQrPayload(pass: string, appOrigin?: string): string {
  const origin = appOrigin?.trim();
  if (!origin) return pass;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return pass; // malformed origin → bare pass, never emit a broken URL
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, ""); // drop trailing slash(es); root → ""
  return `${url.origin}${path === "" ? "/" : path}#${pass}`;
}

/** Render `text` as a compact (half-block) terminal QR string. Resolves the rendered art (never prints
 *  it directly), so the caller routes it to its own sink. */
export function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(text, { small: true }, (out) => resolve(out));
  });
}
