import { describe, expect, it } from "vitest";
import type { FrameHeader } from "./aad.js";
import { open, seal } from "./aead.js";
import { toHex, utf8 } from "./bytes.js";
import { identityHex } from "./tokens.js";
import { decodeFrame, encodeFrame, WireError } from "./wire.js";

const KEY = new Uint8Array(32).fill(9);

function header(extra: Partial<FrameHeader> = {}): FrameHeader {
  return {
    v: 1,
    identityId: new Uint8Array(16).fill(3),
    sessionId: "sess-1",
    dir: "out",
    recordKind: "assistant",
    seq: 0,
    msgId: "m1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...extra,
  };
}

/** A wire object good enough to decode; tests override one field to assert rejection. */
async function goodWire() {
  return encodeFrame(await seal(KEY, header(), utf8("hi")));
}

describe("wire frame codec (§8)", () => {
  it("encode → JSON.stringify → JSON.parse → decode → open round-trips through a real seal", async () => {
    const frame = await seal(KEY, header({ clientMsgId: "c1" }), utf8("hello bus"));
    const overTheWire = JSON.parse(JSON.stringify(encodeFrame(frame)));
    const back = decodeFrame(overTheWire);
    expect(await open(KEY, back)).toEqual(utf8("hello bus"));
    // The cleartext routing header survives intact.
    expect(back.identityId).toEqual(frame.identityId);
    expect(back.clientMsgId).toBe("c1");
    expect(back.seq).toBe(0);
  });

  it("renders identity_id as hex matching identityHex/the token form (one canonical id)", async () => {
    const frame = await seal(KEY, header(), utf8("x"));
    const w = encodeFrame(frame);
    // The wire identity_id is byte-for-byte the same string busToken/sessionToken/the CLI use.
    expect(w.identity_id).toBe(toHex(frame.identityId));
    expect(w.identity_id).toBe(identityHex(frame.identityId));
    expect(w.identity_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uses snake_case wire keys and base64url byte fields (the §8 envelope)", async () => {
    const w = await goodWire();
    expect(Object.keys(w).sort()).toEqual(
      [
        "v",
        "identity_id",
        "session_id",
        "dir",
        "record_kind",
        "seq",
        "msg_id",
        "key_epoch",
        "salt",
        "nonce",
        "ct",
        "part",
        "parts",
      ].sort(),
    );
    expect(w.salt).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  });

  it("omits client_msg_id entirely when absent (not present:false / not null)", async () => {
    const w = await goodWire();
    expect("client_msg_id" in w).toBe(false);
    const back = decodeFrame(w);
    expect("clientMsgId" in back).toBe(false);
  });

  it("carries seq:null through unchanged (control/meta frames)", async () => {
    const w = encodeFrame(
      await seal(KEY, header({ seq: null, recordKind: "session_announce" }), utf8("x")),
    );
    expect(w.seq).toBeNull();
    expect(decodeFrame(w).seq).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(() => decodeFrame(null)).toThrow(WireError);
    expect(() => decodeFrame("frame")).toThrow(WireError);
    expect(() => decodeFrame([])).toThrow(/JSON object/);
  });

  it("rejects a wrong-length identity_id / salt / nonce at the boundary (not inside AES-GCM)", async () => {
    const w = await goodWire();
    // "abcd" is valid hex but only 2 bytes -> rejected for length; "zz" is not hex at all.
    expect(() => decodeFrame({ ...w, identity_id: "abcd" })).toThrow(
      /identity_id must decode to 16/,
    );
    expect(() => decodeFrame({ ...w, identity_id: "zz".repeat(16) })).toThrow(
      /identity_id is not valid hex/,
    );
    expect(() => decodeFrame({ ...w, salt: "AAAA" })).toThrow(/salt must decode to 32/);
    expect(() => decodeFrame({ ...w, nonce: "AAAA" })).toThrow(/nonce must decode to 12/);
  });

  it("rejects a bad dir, a non-integer seq, and a negative part", async () => {
    const w = await goodWire();
    expect(() => decodeFrame({ ...w, dir: "sideways" })).toThrow(/dir must be/);
    expect(() => decodeFrame({ ...w, seq: 1.5 })).toThrow(/seq must be/);
    expect(() => decodeFrame({ ...w, part: -1 })).toThrow(/part must be/);
  });

  it("rejects an out-of-safe-range seq at the boundary (WireError, not a later RangeError)", async () => {
    const w = await goodWire();
    // > Number.MAX_SAFE_INTEGER: must be a clean WireError here, never a RangeError deep in canonicalAad.
    expect(() => decodeFrame({ ...w, seq: Number.MAX_SAFE_INTEGER + 2 })).toThrow(WireError);
    expect(() => decodeFrame({ ...w, seq: Number.MAX_SAFE_INTEGER + 2 })).toThrow(/seq must be/);
  });

  it("rejects invalid base64url and a non-string field", async () => {
    const w = await goodWire();
    expect(() => decodeFrame({ ...w, ct: "not valid !!!" })).toThrow(/ct is not valid base64url/);
    expect(() => decodeFrame({ ...w, session_id: 5 })).toThrow(/session_id must be a string/);
    expect(() => decodeFrame({ ...w, client_msg_id: 5 })).toThrow(/client_msg_id must be a string/);
  });

  it("a decoded frame whose ct was tampered fails AEAD open (the codec doesn't hide tamper)", async () => {
    const w = await goodWire();
    // Flip a byte by re-encoding a mutated ct: decode it (still valid base64url, 16+ bytes), then open must throw.
    const frame = decodeFrame(w);
    frame.ct[0] = (frame.ct[0] ?? 0) ^ 0xff;
    await expect(open(KEY, frame)).rejects.toThrow();
  });
});
