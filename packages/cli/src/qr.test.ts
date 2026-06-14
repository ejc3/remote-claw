import { describe, expect, it } from "vitest";
import { passQrPayload, renderQr } from "./qr.js";

const PASS = "rcp1_SAMPLEpass_AbC-123"; // a stand-in; passQrPayload only string-interpolates it

describe("passQrPayload — what the pass QR encodes", () => {
  it("no origin → the bare pass (manual entry)", () => {
    expect(passQrPayload(PASS)).toBe(PASS);
    expect(passQrPayload(PASS, "")).toBe(PASS);
    expect(passQrPayload(PASS, "   ")).toBe(PASS);
  });

  it("a root origin → the deep link <origin>/#<pass>", () => {
    expect(passQrPayload(PASS, "https://app.example.com")).toBe(`https://app.example.com/#${PASS}`);
  });

  it("strips a trailing slash so root never doubles up", () => {
    expect(passQrPayload(PASS, "https://app.example.com/")).toBe(
      `https://app.example.com/#${PASS}`,
    );
  });

  it("preserves a non-root path (viewer hosted under a subpath)", () => {
    expect(passQrPayload(PASS, "https://app.example.com/viewer")).toBe(
      `https://app.example.com/viewer#${PASS}`,
    );
    expect(passQrPayload(PASS, "https://app.example.com/viewer/")).toBe(
      `https://app.example.com/viewer#${PASS}`,
    );
  });

  it("drops any existing hash/query before appending #<pass>", () => {
    expect(passQrPayload(PASS, "https://app.example.com/#stale")).toBe(
      `https://app.example.com/#${PASS}`,
    );
    expect(passQrPayload(PASS, "https://app.example.com/?x=1")).toBe(
      `https://app.example.com/#${PASS}`,
    );
  });

  it("trims surrounding whitespace on the origin", () => {
    expect(passQrPayload(PASS, "  https://app.example.com  ")).toBe(
      `https://app.example.com/#${PASS}`,
    );
  });

  it("a malformed origin → falls back to the bare pass (never a broken URL)", () => {
    expect(passQrPayload(PASS, "not a url")).toBe(PASS);
    expect(passQrPayload(PASS, "://nope")).toBe(PASS);
  });

  it("an opaque/non-web origin → bare pass (never a `null…#pass` payload)", () => {
    expect(passQrPayload(PASS, "localhost:3000")).toBe(PASS); // no scheme → opaque, origin "null"
    expect(passQrPayload(PASS, "javascript:alert(1)")).toBe(PASS);
    expect(passQrPayload(PASS, "mailto:x@y.z")).toBe(PASS);
    expect(passQrPayload(PASS, "file:///etc/passwd")).toBe(PASS);
  });
});

describe("renderQr — terminal QR rendering", () => {
  it("returns non-empty half-block art and is deterministic for the same input", async () => {
    const a = await renderQr(`https://app.example.com/#${PASS}`);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toMatch(/[▀▄█]/u); // half-block QR glyphs
    const b = await renderQr(`https://app.example.com/#${PASS}`);
    expect(b).toBe(a); // same input → same QR (no randomness)
  });
});
