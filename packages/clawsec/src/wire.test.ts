import { describe, expect, it, vi } from "vitest";
import type { FrameHeader } from "./aad.js";
import { open, seal } from "./aead.js";
import { base64urlDecode } from "./base64url.js";
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

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Change only unused tail bits, producing a different spelling of the same decoded bytes. */
function noncanonicalTailAlias(canonical: string): string {
  const last = canonical.at(-1);
  const index = last === undefined ? -1 : BASE64URL_ALPHABET.indexOf(last);
  if (index < 0 || canonical.length % 4 === 0 || index + 1 >= BASE64URL_ALPHABET.length) {
    throw new Error("fixture has no base64url tail alias");
  }
  return `${canonical.slice(0, -1)}${BASE64URL_ALPHABET[index + 1]}`;
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

  it("reads an optional client message ID only once while encoding", async () => {
    const frame = await seal(KEY, header({ clientMsgId: "client-1" }), utf8("x"));
    let reads = 0;
    Object.defineProperty(frame, "clientMsgId", {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? "client-1" : "changed";
      },
    });

    expect(encodeFrame(frame).client_msg_id).toBe("client-1");
    expect(reads).toBe(1);
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

  it("preflights fixed-size byte fields before attempting a base64 decode", async () => {
    const w = await goodWire();
    const atob = vi.spyOn(globalThis, "atob");
    try {
      expect(() => decodeFrame({ ...w, salt: "A".repeat(1_000_000) })).toThrow(
        /salt must decode to 32 bytes/,
      );
      expect(atob).not.toHaveBeenCalled();

      atob.mockClear();
      expect(() => decodeFrame({ ...w, nonce: "A".repeat(1_000_000) })).toThrow(
        /nonce must decode to 12 bytes/,
      );
      // The valid salt appears first in the frame and is decoded; the oversized nonce is not.
      expect(atob).toHaveBeenCalledTimes(1);
    } finally {
      atob.mockRestore();
    }

    expect(() => decodeFrame({ ...w, identity_id: "a".repeat(1_000_000) })).toThrow(
      /identity_id must decode to 16 bytes/,
    );
  });

  it("rejects noncanonical base64url tail-bit aliases of the same bytes", async () => {
    const w = encodeFrame(await seal(KEY, header(), new Uint8Array()));

    for (const key of ["salt", "ct"] as const) {
      const alias = noncanonicalTailAlias(w[key]);
      expect(base64urlDecode(alias)).toEqual(base64urlDecode(w[key]));
      expect(alias).not.toBe(w[key]);
      expect(() => decodeFrame({ ...w, [key]: alias })).toThrow(
        new RegExp(`${key} must use canonical unpadded base64url`),
      );
    }
  });

  it("rejects a bad dir, a non-integer seq, and a negative part", async () => {
    const w = await goodWire();
    expect(() => decodeFrame({ ...w, dir: "sideways" })).toThrow(/dir must be/);
    expect(() => decodeFrame({ ...w, seq: 1.5 })).toThrow(/seq must be/);
    expect(() => decodeFrame({ ...w, seq: -0 })).toThrow(/seq must be/);
    expect(() => decodeFrame({ ...w, part: -1 })).toThrow(/part must be/);
    expect(() => decodeFrame({ ...w, key_epoch: -0 })).toThrow(/key_epoch must be/);
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

  it("rejects oversized free-form routing strings at the wire boundary", async () => {
    const w = await goodWire();
    expect(() => decodeFrame({ ...w, session_id: "s".repeat(257) })).toThrow(WireError);
    expect(() => decodeFrame({ ...w, session_id: "s".repeat(257) })).toThrow(
      /session_id must be at most 256/,
    );
    expect(() => decodeFrame({ ...w, record_kind: "r".repeat(257) })).toThrow(WireError);
    expect(() => decodeFrame({ ...w, msg_id: "m".repeat(1025) })).toThrow(WireError);
    expect(() => decodeFrame({ ...w, client_msg_id: "c".repeat(257) })).toThrow(WireError);
  });

  it("rejects control characters in plane-determining routing strings", async () => {
    const w = await goodWire();
    expect(() => decodeFrame({ ...w, session_id: "sess\n1" })).toThrow(WireError);
    expect(() => decodeFrame({ ...w, session_id: "sess\n1" })).toThrow(
      /session_id must not contain ASCII control/,
    );
    expect(() => decodeFrame({ ...w, record_kind: "assistant\u0000x" })).toThrow(WireError);
    expect(() => decodeFrame({ ...w, record_kind: "assistant\u007fx" })).toThrow(WireError);
  });

  it("rejects lone surrogates in every free-form header string but accepts scalar pairs", async () => {
    const w = await goodWire();
    const malformed = [
      ["session_id", "\ud800"],
      ["record_kind", `assistant\udc00`],
      ["msg_id", `m\ud800x`],
      ["client_msg_id", "\udc00"],
    ] as const;

    for (const [key, value] of malformed) {
      expect(() => decodeFrame({ ...w, [key]: value })).toThrow(WireError);
      expect(() => decodeFrame({ ...w, [key]: value })).toThrow(/Unicode scalar values/);
    }

    expect(decodeFrame({ ...w, msg_id: "m-😀" }).msgId).toBe("m-😀");
  });

  it("requires selected fields to be own data properties without invoking accessors", async () => {
    const w = await goodWire();
    let requiredAccessorReads = 0;
    const requiredAccessor = { ...w };
    Object.defineProperty(requiredAccessor, "session_id", {
      enumerable: true,
      get() {
        requiredAccessorReads++;
        return "changed";
      },
    });
    expect(() => decodeFrame(requiredAccessor)).toThrow(/session_id must be an own data property/);
    expect(requiredAccessorReads).toBe(0);

    let optionalAccessorReads = 0;
    const optionalAccessor = { ...w };
    Object.defineProperty(optionalAccessor, "client_msg_id", {
      enumerable: true,
      get() {
        optionalAccessorReads++;
        return optionalAccessorReads === 1 ? "first" : "changed";
      },
    });
    expect(() => decodeFrame(optionalAccessor)).toThrow(
      /client_msg_id must be an own data property/,
    );
    expect(optionalAccessorReads).toBe(0);

    expect(() => decodeFrame(Object.create(w))).toThrow(/v must be an own data property/);
  });

  it("snapshots each selected proxy field once without ordinary property reads", async () => {
    const w = encodeFrame(await seal(KEY, header({ clientMsgId: "client-1" }), utf8("hi")));
    let propertyReads = 0;
    const descriptorReads = new Map<PropertyKey, number>();
    const proxy = new Proxy(w, {
      get() {
        propertyReads++;
        throw new Error("ordinary property access must not occur");
      },
      getOwnPropertyDescriptor(target, key) {
        descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const decoded = decodeFrame(proxy);
    expect(decoded.clientMsgId).toBe("client-1");
    expect(propertyReads).toBe(0);
    expect(descriptorReads.get("client_msg_id")).toBe(1);
    expect([...descriptorReads.values()].every((count) => count === 1)).toBe(true);
  });

  it("redacts hostile and revoked proxy inspection failures as WireError", async () => {
    const w = await goodWire();
    const secret = "proxy-inspection-secret";
    const hostile = new Proxy(w, {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    });

    let error: unknown;
    try {
      decodeFrame(hostile);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WireError);
    expect(String(error)).toContain("frame could not be inspected safely");
    expect(String(error)).not.toContain(secret);

    const { proxy, revoke } = Proxy.revocable(w, {});
    revoke();
    expect(() => decodeFrame(proxy)).toThrow(WireError);
    expect(() => decodeFrame(proxy)).toThrow(/frame could not be inspected safely/);
  });

  it("round-trips a real-shaped RC frame within the routing string bounds", async () => {
    const body = JSON.stringify({
      request_id: "perm-e2e-1",
      tool_name: "Bash",
      tool_input: { command: "pnpm vitest run src" },
    });
    const frame = await seal(
      KEY,
      header({
        sessionId: "cse_7f3e2d1c0b9a8",
        recordKind: "permission_request",
        msgId: "permission_request-42",
        clientMsgId: "web-01HQRCF6KZ8N3Q9J4V2R",
      }),
      utf8(body),
    );
    const back = decodeFrame(JSON.parse(JSON.stringify(encodeFrame(frame))));
    expect(back.sessionId).toBe("cse_7f3e2d1c0b9a8");
    expect(back.recordKind).toBe("permission_request");
    expect(back.clientMsgId).toBe("web-01HQRCF6KZ8N3Q9J4V2R");
    expect(await open(KEY, back)).toEqual(utf8(body));
  });

  it("a decoded frame whose ct was tampered fails AEAD open (the codec doesn't hide tamper)", async () => {
    const w = await goodWire();
    // Flip a byte by re-encoding a mutated ct: decode it (still valid base64url, 16+ bytes), then open must throw.
    const frame = decodeFrame(w);
    frame.ct[0] = (frame.ct[0] ?? 0) ^ 0xff;
    await expect(open(KEY, frame)).rejects.toThrow();
  });
});
