import type { Frame } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { FrameOrderer } from "./order.js";

// A minimal Frame whose only fields the orderer reads are seq, msgId, part, parts. The byte fields
// are irrelevant here (the orderer never decrypts) — fill them with empties.
function frame(extra: Partial<Frame> & Pick<Frame, "msgId">): Frame {
  return {
    v: 1,
    identityId: new Uint8Array(16),
    sessionId: "s",
    dir: "out",
    recordKind: "assistant",
    seq: 0,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    salt: new Uint8Array(32),
    nonce: new Uint8Array(12),
    ct: new Uint8Array(0),
    ...extra,
  };
}

const ids = (frames: Frame[]) => frames.map((f) => f.msgId);

describe("FrameOrderer (dedup + reorder, §6/§12)", () => {
  it("delivers in-order content immediately", () => {
    const o = new FrameOrderer();
    expect(ids(o.accept(frame({ msgId: "a", seq: 0 })))).toEqual(["a"]);
    expect(ids(o.accept(frame({ msgId: "b", seq: 1 })))).toEqual(["b"]);
    expect(o.nextSeq).toBe(2);
  });

  it("buffers an out-of-order frame and releases the run once the gap fills", () => {
    const o = new FrameOrderer();
    expect(ids(o.accept(frame({ msgId: "c", seq: 2 })))).toEqual([]); // gap at 0,1
    expect(o.pending).toBe(1);
    expect(ids(o.accept(frame({ msgId: "a", seq: 0 })))).toEqual(["a"]);
    expect(ids(o.accept(frame({ msgId: "b", seq: 1 })))).toEqual(["b", "c"]); // 1 fills → 1,2 flush
    expect(o.pending).toBe(0);
  });

  it("drops a duplicate (same msg_id) regardless of arrival order", () => {
    const o = new FrameOrderer();
    expect(ids(o.accept(frame({ msgId: "a", seq: 0 })))).toEqual(["a"]);
    expect(ids(o.accept(frame({ msgId: "a", seq: 0 })))).toEqual([]); // exact dup
  });

  it("dedups chunked frames by (msg_id, part), not msg_id alone", () => {
    const o = new FrameOrderer();
    const p0 = frame({ msgId: "big", seq: 0, part: 0, parts: 2 });
    const p1 = frame({ msgId: "big", seq: 1, part: 1, parts: 2 });
    expect(ids(o.accept(p0))).toEqual(["big"]);
    expect(ids(o.accept(p1))).toEqual(["big"]); // different part -> not a dup
    expect(ids(o.accept(p0))).toEqual([]); // same part -> dup
  });

  it("delivers control/meta frames (seq=null) immediately, deduped", () => {
    const o = new FrameOrderer();
    expect(
      ids(o.accept(frame({ msgId: "ann", seq: null, recordKind: "session_announce" }))),
    ).toEqual(["ann"]);
    expect(ids(o.accept(frame({ msgId: "ann", seq: null })))).toEqual([]); // dup
    expect(o.nextSeq).toBe(0); // null frames don't advance the content cursor
  });

  it("drops a stale content frame whose seq is already past the cursor", () => {
    const o = new FrameOrderer(5); // resume: next expected seq is 5
    expect(ids(o.accept(frame({ msgId: "old", seq: 3 })))).toEqual([]); // already delivered range
    expect(o.pending).toBe(0); // not buffered (would leak)
    expect(ids(o.accept(frame({ msgId: "now", seq: 5 })))).toEqual(["now"]);
  });

  it("bounds the dedup window (evicts oldest) so it can't grow forever", () => {
    const o = new FrameOrderer(0, 2); // cap = 2 seen keys
    o.accept(frame({ msgId: "x", seq: null }));
    o.accept(frame({ msgId: "y", seq: null }));
    o.accept(frame({ msgId: "z", seq: null })); // evicts "x"
    // "x" was evicted, so it's no longer remembered as seen -> re-delivered (acceptable: bounded window).
    expect(ids(o.accept(frame({ msgId: "x", seq: null })))).toEqual(["x"]);
  });
});
