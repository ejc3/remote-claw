import {
  busToken,
  decodeFrame,
  encodeFrame,
  type FrameHeader,
  fromHex,
  seal,
  timingSafeEqual,
  toHex,
  utf8,
} from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { identityFromRequest } from "../lib/auth";
import { channelToken } from "../lib/channel";

function reqWithBearer(token: string): Request {
  return new Request("https://app.test/api/relay", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function header(identityId: Uint8Array): FrameHeader {
  return {
    v: 1,
    identityId,
    sessionId: "sess-1",
    dir: "out",
    recordKind: "assistant",
    seq: 0,
    msgId: "m1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
  };
}

describe("auth bearer canonicalization", () => {
  it("treats case-different hex bearers as the same bytes and identity", async () => {
    const lower = "0123456789abcdeffedcba987654321000112233445566778899aabbccddeeff";
    const upper = lower.toUpperCase();

    expect(fromHex(upper)).toEqual(fromHex(lower));

    const upperId = await identityFromRequest(reqWithBearer(upper));
    const lowerId = await identityFromRequest(reqWithBearer(lower));
    expect(upperId).toHaveLength(16);
    expect(timingSafeEqual(upperId, lowerId)).toBe(true);

    const token = channelToken(upperId, null);
    expect(token).toBe(busToken(lowerId));
    expect(token).toBe(token.toLowerCase());

    const wireIdentity = fromHex("abcdef0123456789fedcba9876543210");
    const frame = await seal(new Uint8Array(32).fill(3), header(wireIdentity), utf8("x"));
    const wire = encodeFrame(frame);
    const decoded = decodeFrame({ ...wire, identity_id: "AbCdEf0123456789FeDcBa9876543210" });
    expect(timingSafeEqual(decoded.identityId, wireIdentity)).toBe(true);
    expect(toHex(decoded.identityId)).toBe("abcdef0123456789fedcba9876543210");
  });
});
