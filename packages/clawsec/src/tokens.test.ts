import { describe, expect, it } from "vitest";
import { busToken, identityHex, sessionToken } from "./tokens.js";

const ID = new Uint8Array(16).fill(0xab); // 16 bytes -> "abab…ab" (32 hex chars)
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);

describe("channel tokens (§6A/§6B)", () => {
  it("identityHex renders the 16-byte id as 32 lowercase hex chars", () => {
    expect(identityHex(ID)).toBe("ab".repeat(16));
    expect(identityHex(ID)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects an identity id that is not 16 bytes", () => {
    expect(() => identityHex(new Uint8Array(15))).toThrow(/16 bytes/);
    expect(() => busToken(new Uint8Array(17))).toThrow(/16 bytes/);
  });

  it("busToken is bus:<identity_id> and is purely derivable (no lookup)", () => {
    expect(busToken(ID)).toBe(`bus:${"ab".repeat(16)}`);
    // Same input -> same token, on every caller (host, broker, web client).
    expect(busToken(ID)).toBe(busToken(ID.slice()));
  });

  it("sessionToken is sess:<identity_id>:<session_id> with the session id verbatim", () => {
    expect(sessionToken(ID, "abc-123")).toBe(`sess:${"ab".repeat(16)}:abc-123`);
  });

  it("the bus and session namespaces never collide for the same identity", () => {
    expect(busToken(ID)).not.toBe(sessionToken(ID, "x"));
    expect(sessionToken(ID, "x")).not.toBe(sessionToken(ID, "y"));
  });

  it("rejects an empty or control-char session id (routing-label injection)", () => {
    expect(() => sessionToken(ID, "")).toThrow(/non-empty/);
    expect(() => sessionToken(ID, "a\nb")).toThrow(/control character/);
    expect(() => sessionToken(ID, `a${NUL}b`)).toThrow(/control character/);
    expect(() => sessionToken(ID, `a${DEL}b`)).toThrow(/control character/);
  });
});
