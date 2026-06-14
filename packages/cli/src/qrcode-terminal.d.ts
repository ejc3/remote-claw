// Minimal ambient types for `qrcode-terminal` (untyped, zero-dependency package). We use only
// `generate(text, {small}, cb)` — the callback form, which hands back the rendered QR string instead
// of printing it, so we can route it through our own stderr sink and unit-test it.
declare module "qrcode-terminal" {
  export interface GenerateOptions {
    small?: boolean;
  }
  interface Generate {
    (input: string, opts: GenerateOptions, cb: (output: string) => void): void;
    (input: string, cb: (output: string) => void): void;
  }
  const qrcodeTerminal: { generate: Generate; setErrorLevel(level: "L" | "M" | "Q" | "H"): void };
  export default qrcodeTerminal;
}
