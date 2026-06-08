import { describe, expect, it } from "vitest";
import { AeadError, type Frame } from "./aead.js";
import { fromHex, toHex } from "./bytes.js";
import { ChunkError, type ChunkHeader, openChunked, sealChunked, splitPlaintext } from "./chunk.js";

const KEY = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

function header(over: Partial<ChunkHeader> = {}): ChunkHeader {
  return {
    v: 1,
    identityId: fromHex("00112233445566778899aabbccddeeff"),
    sessionId: "s1",
    dir: "out",
    recordKind: "assistant",
    seq: 1,
    msgId: "m1",
    keyEpoch: 0,
    ...over,
  };
}

describe("splitPlaintext", () => {
  it("splits by size, including empty and exact-multiple cases", () => {
    expect(splitPlaintext(new Uint8Array(0), 4).map((c) => c.length)).toEqual([0]);
    expect(splitPlaintext(new Uint8Array(10), 4).map((c) => c.length)).toEqual([4, 4, 2]);
    expect(splitPlaintext(new Uint8Array(8), 4).map((c) => c.length)).toEqual([4, 4]);
    expect(splitPlaintext(new Uint8Array(3), 4).map((c) => c.length)).toEqual([3]);
  });
  it("rejects a non-positive chunk size", () => {
    expect(() => splitPlaintext(new Uint8Array(4), 0)).toThrow(ChunkError);
    expect(() => splitPlaintext(new Uint8Array(4), -1)).toThrow(ChunkError);
  });
});

describe("chunked AEAD round-trip", () => {
  it("round-trips across many sizes", async () => {
    for (const len of [0, 1, 999, 1000, 1001, 4096]) {
      const pt = crypto.getRandomValues(new Uint8Array(len));
      const frames = await sealChunked(KEY, header(), pt, 1000);
      expect(frames.length).toBe(Math.max(1, Math.ceil(len / 1000)));
      expect(frames.every((f) => f.parts === frames.length)).toBe(true);
      expect(toHex(await openChunked(KEY, frames))).toBe(toHex(pt));
    }
  });

  it("reassembles regardless of frame arrival order", async () => {
    const pt = crypto.getRandomValues(new Uint8Array(3500));
    const frames = await sealChunked(KEY, header(), pt, 1000); // 4 chunks
    const shuffled = [frames[3], frames[1], frames[0], frames[2]] as Frame[];
    expect(toHex(await openChunked(KEY, shuffled))).toBe(toHex(pt));
  });

  it("a single chunk behaves like a normal frame", async () => {
    const pt = new Uint8Array(0);
    const frames = await sealChunked(KEY, header(), pt, 1000);
    expect(frames.length).toBe(1);
    expect(frames[0]?.part).toBe(0);
    expect(frames[0]?.parts).toBe(1);
    expect((await openChunked(KEY, frames)).length).toBe(0);
  });
});

describe("chunked reassembly rejection", () => {
  async function fourChunks(): Promise<Frame[]> {
    return sealChunked(KEY, header(), crypto.getRandomValues(new Uint8Array(3500)), 1000);
  }

  it("rejects a missing chunk", async () => {
    const frames = await fourChunks();
    await expect(openChunked(KEY, frames.slice(1))).rejects.toBeInstanceOf(ChunkError);
  });

  it("rejects a duplicated chunk", async () => {
    const frames = await fourChunks();
    await expect(
      openChunked(KEY, [frames[0], frames[1], frames[2], frames[2]] as Frame[]),
    ).rejects.toBeInstanceOf(ChunkError);
  });

  it("rejects a tampered chunk (AEAD)", async () => {
    const frames = await fourChunks();
    const bad = frames.slice() as Frame[];
    const ct = (bad[2] as Frame).ct.slice();
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    bad[2] = { ...(bad[2] as Frame), ct };
    await expect(openChunked(KEY, bad)).rejects.toBeInstanceOf(AeadError);
  });

  it("rejects a reordered chunk (part rewritten -> AAD fails)", async () => {
    const frames = await fourChunks();
    const bad = frames.slice() as Frame[];
    bad[1] = { ...(bad[1] as Frame), part: 2 }; // claim a different index without re-sealing
    await expect(openChunked(KEY, bad)).rejects.toThrow(); // duplicate-part or AEAD
  });

  it("rejects frames from two different messages mixed together", async () => {
    const a = await sealChunked(KEY, header({ msgId: "mA" }), new Uint8Array(2500), 1000); // 3
    const b = await sealChunked(KEY, header({ msgId: "mB" }), new Uint8Array(2500), 1000); // 3
    const mixed = [a[0], a[1], b[2]] as Frame[];
    await expect(openChunked(KEY, mixed)).rejects.toBeInstanceOf(ChunkError);
  });

  it("rejects an empty frame list and an inconsistent parts count", async () => {
    await expect(openChunked(KEY, [])).rejects.toBeInstanceOf(ChunkError);
    const frames = await fourChunks();
    const tweaked = [{ ...(frames[0] as Frame), parts: 4 }, frames[1], frames[2]] as Frame[];
    await expect(openChunked(KEY, tweaked)).rejects.toBeInstanceOf(ChunkError);
  });

  it("rejects mixing chunks that differ in ANY header field (sameMessage)", async () => {
    const a = await sealChunked(KEY, header(), new Uint8Array(2500), 1000); // 3 chunks (msgId m1)
    const differingFields: Partial<ChunkHeader>[] = [
      { identityId: fromHex("ffffffffffffffffffffffffffffffff") },
      { sessionId: "other" },
      { dir: "in" },
      { recordKind: "user" },
      { seq: 999 },
      { keyEpoch: 7 },
      { clientMsgId: "c-x" },
      { v: 2 },
    ];
    for (const over of differingFields) {
      const b = await sealChunked(KEY, header(over), new Uint8Array(2500), 1000);
      const mixed = [a[0], b[1], b[2]] as Frame[]; // count matches parts=3 but headers differ
      await expect(openChunked(KEY, mixed)).rejects.toBeInstanceOf(ChunkError);
    }
  });

  it("rejects an absurd parts count without allocating", async () => {
    const f = await sealChunked(KEY, header(), new Uint8Array(10), 1000); // 1 frame
    const evil = [{ ...(f[0] as Frame), parts: 1_000_000_000 }] as Frame[];
    await expect(openChunked(KEY, evil)).rejects.toBeInstanceOf(ChunkError);
  });
});

describe("splitPlaintext returns copies", () => {
  it("isolates the caller from later mutation of the source buffer", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const pieces = splitPlaintext(src, 3);
    src[0] = 99;
    expect(Array.from(pieces[0] as Uint8Array)).toEqual([1, 2, 3]);
  });
});
