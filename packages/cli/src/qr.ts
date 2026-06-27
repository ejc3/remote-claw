// QR rendering for `--rc-pass --rc-qr` — a presentation helper, NOT crypto (the pass it encodes is
// already the clawsec viewer credential). The pass was designed to be "QR/file-sized" (pass.ts §4.2a);
// this renders it as a compact terminal QR so a phone can scan it.
//
// NOTE: there is no `<origin>/#<pass>` deep-link builder here anymore. That forever-credential-in-URL
// shape was replaced by the one-time OTK handoff (docs/ephemeral-handoff.md): with `--rc-app`, pass.ts
// uploads a one-time box and the QR carries `<origin>/#otk1_<OTK>`; without it, the QR is the bare pass
// for manual entry. Re-introducing a `#<pass>` deep link would resurrect the dropped anti-pattern.
import qrcodeTerminal from "qrcode-terminal";

/** Render `text` as a compact (half-block) terminal QR string. Resolves the rendered art (never prints
 *  it directly), so the caller routes it to its own sink. */
export function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(text, { small: true }, (out) => resolve(out));
  });
}
