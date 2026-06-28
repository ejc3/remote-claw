import { describe, expect, it } from "vitest";
import { isNearBottom, transcriptScrollAction } from "../app/page.js";

// #design-pass regression guard for the worst transcript bug: the transcript used to autoscroll to
// the bottom on EVERY new frame, yanking the reader down mid-scroll while history was being read.
// The fix gates autoscroll on isNearBottom() — only stick when already within `threshold`px of the
// foot; otherwise hold position and surface a "jump to latest" pill. These cases pin the predicate so
// a future refactor can't silently re-introduce the yank.
describe("isNearBottom (stick-to-bottom predicate)", () => {
  it("is true when pinned exactly at the bottom", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })).toBe(true);
  });

  it("is true within the default 64px threshold of the bottom", () => {
    // remaining = 1000 - 637 - 300 = 63 < 64
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 637, clientHeight: 300 })).toBe(true);
  });

  it("is false at or beyond the threshold (reading history → don't yank)", () => {
    // remaining = 1000 - 636 - 300 = 64, NOT < 64
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 636, clientHeight: 300 })).toBe(false);
    // scrolled well up the transcript
    expect(isNearBottom({ scrollHeight: 5000, scrollTop: 100, clientHeight: 800 })).toBe(false);
  });

  it("treats an unscrollable (content shorter than viewport) container as at-bottom", () => {
    // remaining = 300 - 0 - 800 = -500 < 64 → stick (there is no 'up' to read)
    expect(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 800 })).toBe(true);
  });

  it("honors a custom threshold", () => {
    // remaining = 1000 - 600 - 300 = 100
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }, 64)).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }, 128)).toBe(true);
  });
});

// transcriptScrollAction is the decision the message-arrival effect makes. Two regressions caught in
// review motivate the cases: (a) when pinned at the bottom it must ALWAYS follow (the old smooth scroll
// could latch "not at bottom" mid-animation and stop following a streaming turn — the follow is now an
// instant scrollTop, and this pins the decision); (b) when scrolled up it must only show the pill when
// content actually GREW, so an in-place frame (a resolved permission renders null, an optimistic echo
// reconciles in place) doesn't pop a pill with nothing to jump to.
describe("transcriptScrollAction (stick-to-bottom decision)", () => {
  it("follows the foot whenever the reader is pinned at the bottom (regardless of growth)", () => {
    expect(transcriptScrollAction(true, true)).toBe("follow");
    expect(transcriptScrollAction(true, false)).toBe("follow"); // even an in-place update keeps us pinned
  });

  it("shows the jump pill when scrolled up AND visible content grew", () => {
    expect(transcriptScrollAction(false, true)).toBe("show-pill");
  });

  it("does nothing when scrolled up and nothing visible was added (no spurious pill)", () => {
    expect(transcriptScrollAction(false, false)).toBe("none");
  });
});
