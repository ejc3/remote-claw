import { describe, expect, it } from "vitest";
import { renderQr } from "./qr.js";

// NOTE: there is no `passQrPayload` deep-link builder anymore — the `<origin>/#<pass>` forever-credential
// QR shape was dropped for the one-time OTK handoff (pass.ts emits `<origin>/#otk1_<OTK>` with --rc-app, or
// the bare pass without). renderQr just turns whatever text it's given into terminal QR art.
describe("renderQr — terminal QR rendering", () => {
  it("returns non-empty half-block art and is deterministic for the same input", async () => {
    const sample = "https://app.example.com/#otk1_SAMPLEtoken"; // representative one-time pairing link
    const a = await renderQr(sample);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toMatch(/[▀▄█]/u); // half-block QR glyphs
    const b = await renderQr(sample);
    expect(b).toBe(a); // same input → same QR (no randomness)
  });
});
