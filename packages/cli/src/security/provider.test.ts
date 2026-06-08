import {
  AeadError,
  deriveIdentity,
  type FrameHeader,
  type Identity,
  utf8,
} from "@remote-claw/clawsec";
import { beforeEach, describe, expect, it } from "vitest";
import { type Plane, securityProvider } from "./provider.js";

function header(extra: Partial<FrameHeader> = {}): FrameHeader {
  return {
    v: 1,
    identityId: new Uint8Array(16),
    sessionId: "sess-1",
    dir: "out",
    recordKind: "content",
    seq: 0,
    msgId: "m1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...extra,
  };
}

const PLANES: Plane[] = ["session", "control", "meta"];

describe("securityProvider — Open / Sealed (§2A)", () => {
  let id: Identity;
  beforeEach(async () => {
    id = await deriveIdentity(new Uint8Array(32).fill(7));
  });

  it("authBearer is auth_token at every level (routing/admission is level-independent)", () => {
    expect(securityProvider("open", id).authBearer()).toEqual(id.authToken);
    expect(securityProvider("sealed", id).authBearer()).toEqual(id.authToken);
  });

  it("authBearer returns a copy — mutating it can't corrupt the identity's key", () => {
    for (const level of ["open", "sealed"] as const) {
      const p = securityProvider(level, id);
      const bearer = p.authBearer();
      bearer[0] = (bearer[0] ?? 0) ^ 0xff;
      expect(p.authBearer()).toEqual(id.authToken); // a second call is still pristine
    }
  });

  it("the factory builds the requested level", () => {
    expect(securityProvider("open", id).level).toBe("open");
    expect(securityProvider("sealed", id).level).toBe("sealed");
  });

  describe("Open (no encryption — the relay sees everything)", () => {
    it("seals the plaintext verbatim into ct (no encryption) and round-trips", async () => {
      const p = securityProvider("open", id);
      const pt = utf8("hello world");
      const f = await p.sealFrame("session", header(), pt);
      expect(f.ct).toEqual(pt); // the content is in the clear — the server can read it
      expect(f.salt).toEqual(new Uint8Array(32));
      expect(f.nonce).toEqual(new Uint8Array(12));
      expect(await p.openFrame("session", f)).toEqual(pt);
    });

    it("uses a fresh salt/nonce buffer per frame (no cross-frame aliasing)", async () => {
      const p = securityProvider("open", id);
      const a = await p.sealFrame("session", header(), utf8("a"));
      const b = await p.sealFrame("session", header(), utf8("b"));
      expect(a.salt).not.toBe(b.salt);
      expect(a.nonce).not.toBe(b.nonce);
    });

    it("does not alias the caller's plaintext into ct (caller may reuse the buffer)", async () => {
      const p = securityProvider("open", id);
      const pt = utf8("mutate me");
      const f = await p.sealFrame("session", header(), pt);
      pt[0] = (pt[0] ?? 0) ^ 0xff; // caller scribbles on its buffer after sealing
      expect(f.ct).not.toEqual(pt); // the frame kept its own copy
    });

    it("openFrame returns a copy, not a view onto frame.ct", async () => {
      const p = securityProvider("open", id);
      const f = await p.sealFrame("session", header(), utf8("hi"));
      const out = await p.openFrame("session", f);
      out[0] = (out[0] ?? 0) ^ 0xff; // mutating the result must not touch the frame
      expect(f.ct).not.toEqual(out);
    });
  });

  describe("Sealed (E2E AES-256-GCM)", () => {
    it("round-trips on every plane; the ciphertext is not the plaintext", async () => {
      const p = securityProvider("sealed", id);
      for (const plane of PLANES) {
        const pt = utf8(`secret-${plane}`);
        const f = await p.sealFrame(plane, header({ recordKind: plane }), pt);
        expect(f.ct).not.toEqual(pt); // encrypted
        expect(f.ct.length).toBe(pt.length + 16); // + 16-byte GCM tag
        expect(await p.openFrame(plane, f)).toEqual(pt);
      }
    });

    it("uses a distinct per-plane key: a control frame can't be opened as session", async () => {
      const p = securityProvider("sealed", id);
      const f = await p.sealFrame("control", header(), utf8("a command"));
      await expect(p.openFrame("session", f)).rejects.toBeInstanceOf(AeadError);
    });

    it("DOWNGRADE FLOOR: a Sealed client refuses a non-AEAD (Open / plaintext) frame", async () => {
      const openP = securityProvider("open", id);
      const sealedP = securityProvider("sealed", id);
      const plainFrame = await openP.sealFrame(
        "session",
        header(),
        utf8("trust me, I'm plaintext"),
      );
      await expect(sealedP.openFrame("session", plainFrame)).rejects.toBeInstanceOf(AeadError);
    });

    it("rejects a tampered ciphertext", async () => {
      const p = securityProvider("sealed", id);
      const f = await p.sealFrame("session", header(), utf8("hi"));
      f.ct[0] = (f.ct[0] ?? 0) ^ 0xff;
      await expect(p.openFrame("session", f)).rejects.toBeInstanceOf(AeadError);
    });

    it("a frame from a DIFFERENT identity does not open (wrong keys)", async () => {
      const mine = securityProvider("sealed", id);
      const theirs = securityProvider("sealed", await deriveIdentity(new Uint8Array(32).fill(8)));
      const f = await theirs.sealFrame("session", header(), utf8("not yours"));
      await expect(mine.openFrame("session", f)).rejects.toBeInstanceOf(AeadError);
    });
  });
});
