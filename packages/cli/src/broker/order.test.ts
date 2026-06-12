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

  it("holds a chunked message (parts share one seq) until complete, then releases all parts in order", () => {
    const o = new FrameOrderer();
    // A 2-part message: both parts carry the SAME seq, differing only by `part` (§8).
    const p0 = frame({ msgId: "big", seq: 0, part: 0, parts: 2 });
    const p1 = frame({ msgId: "big", seq: 0, part: 1, parts: 2 });
    expect(o.accept(p0)).toEqual([]); // incomplete — the message's seq slot is held (like a gap)
    expect(o.stalledOnMissingSeq).toBe(false);
    expect(o.stalledOnIncompleteSeq).toBe(true);
    expect(o.stalled).toBe(true);
    expect(o.accept(p1).map((f) => f.part)).toEqual([0, 1]); // complete → both parts, in part order
    expect(o.stalled).toBe(false);
    expect(o.accept(p0)).toEqual([]); // a re-sent part is deduped by (msg_id, part)
    expect(o.nextSeq).toBe(1); // the whole chunked message occupied exactly ONE transcript seq
  });

  it("guards a seq slot to one message: a foreign-msg_id frame at the same seq is dropped", () => {
    const o = new FrameOrderer();
    expect(o.accept(frame({ msgId: "real", seq: 0, part: 0, parts: 2 }))).toEqual([]); // accumulating
    expect(o.accept(frame({ msgId: "intruder", seq: 0, part: 0, parts: 1 }))).toEqual([]); // dropped
    // The real message completes and releases cleanly — only its own two parts, no intruder.
    expect(
      o.accept(frame({ msgId: "real", seq: 0, part: 1, parts: 2 })).map((f) => f.msgId),
    ).toEqual(["real", "real"]);
  });

  it("does not falsely complete a chunked message on a replayed part after dedup-window eviction", () => {
    const o = new FrameOrderer(0, 1); // dedup cap = 1 → keys evict fast, so a replay can slip past it
    const p = (part: number) => frame({ msgId: "m", seq: 0, part, parts: 3 });
    expect(o.accept(p(0))).toEqual([]); // part 0 buffered
    expect(o.accept(p(1))).toEqual([]); // part 1 buffered (evicts the "m:0" dedup key)
    // The "m:0" key evicted, so this replay passes the dedup window — but the SLOT rejects the dup part,
    // so the message is NOT falsely "complete" with [0,1,0] (which would corrupt + lose the real part 2).
    expect(o.accept(p(0))).toEqual([]); // duplicate part dropped at the slot
    expect(o.pending).toBe(1); // still held — part 2 is genuinely missing
    expect(o.accept(p(2)).map((f) => f.part)).toEqual([0, 1, 2]); // the real part 2 completes it cleanly
  });

  it("reassembles a chunked message even when its parts arrive out of order", () => {
    const o = new FrameOrderer();
    expect(o.accept(frame({ msgId: "m", seq: 0, part: 2, parts: 3 }))).toEqual([]);
    expect(o.accept(frame({ msgId: "m", seq: 0, part: 0, parts: 3 }))).toEqual([]);
    expect(o.accept(frame({ msgId: "m", seq: 0, part: 1, parts: 3 })).map((f) => f.part)).toEqual([
      0, 1, 2,
    ]);
  });

  it("delivers control/meta frames (seq=null) immediately, deduped", () => {
    const o = new FrameOrderer();
    expect(
      ids(o.accept(frame({ msgId: "ann", seq: null, recordKind: "session_announce" }))),
    ).toEqual(["ann"]);
    expect(ids(o.accept(frame({ msgId: "ann", seq: null })))).toEqual([]); // dup
    expect(o.nextSeq).toBe(0); // null frames don't advance the content cursor
  });

  it("delivers permission_resolved immediately even while a content gap is open", () => {
    const o = new FrameOrderer();
    expect(ids(o.accept(frame({ msgId: "later", seq: 1 })))).toEqual([]);
    expect(o.pending).toBe(1);
    expect(
      ids(o.accept(frame({ msgId: "resolved", seq: null, recordKind: "permission_resolved" }))),
    ).toEqual(["resolved"]);
    expect(o.nextSeq).toBe(0);
    expect(o.pending).toBe(1);
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

  it("does NOT double-deliver a parts=1 content frame re-read after its dedup key evicted", () => {
    // The adversarial-review case: a non-chunked frame buffered behind a gap whose msg_id evicts from
    // the bounded window, then is re-read (reconnect re-reads from index 0). Before the per-slot guard
    // it was pushed into the seq slot twice and drained as two transcript entries with the same seq.
    const o = new FrameOrderer(0, 2); // tiny dedup window so we can force an eviction
    expect(ids(o.accept(frame({ msgId: "m1", seq: 1 })))).toEqual([]); // buffered behind the seq-0 gap
    // Churn the window with two other (seq:null) keys → "m1" evicts.
    o.accept(frame({ msgId: "x1", seq: null, recordKind: "accepted" }));
    o.accept(frame({ msgId: "x2", seq: null, recordKind: "accepted" }));
    // Re-read seq 1 (same msg_id): #markSeen passes (key evicted), but the per-slot guard drops it.
    expect(ids(o.accept(frame({ msgId: "m1", seq: 1 })))).toEqual([]);
    // Fill the seq-0 gap → drains 0 then 1, EACH EXACTLY ONCE (no duplicate seq-1 entry).
    expect(ids(o.accept(frame({ msgId: "m0", seq: 0 })))).toEqual(["m0", "m1"]);
  });

  it("keeps exactly one frame in a buffered parts=1 slot (head-mismatch and same-id dup both drop)", () => {
    const o = new FrameOrderer(0);
    expect(ids(o.accept(frame({ msgId: "a", seq: 2 })))).toEqual([]); // buffered behind gap
    expect(ids(o.accept(frame({ msgId: "b", seq: 2 })))).toEqual([]); // head mismatch → dropped
    expect(ids(o.accept(frame({ msgId: "a", seq: 2 })))).toEqual([]); // same-id re-read → per-slot dup
    expect(ids(o.accept(frame({ msgId: "s0", seq: 0 })))).toEqual(["s0"]); // delivers now, cursor → 1
    expect(ids(o.accept(frame({ msgId: "s1", seq: 1 })))).toEqual(["s1", "a"]); // s1 then buffered 'a', once
  });
});
