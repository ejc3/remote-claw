import { describe, expect, it } from "vitest";
import { parsePermissionResolved } from "../app/lib/transcript.js";
import {
  type Announce,
  CONNECTED_WINDOW_MS,
  connState,
  emptyTranscriptHint,
  FRESH_WINDOW_MS,
  parseGit,
  RECONNECTING_WINDOW_MS,
  shouldAcceptAnnounce,
} from "../app/lib/viewer.js";
import { displayedPermissionMode } from "../app/page.js";

// The connection-state ladder (#58): connected (fresh) → reconnecting (full grace window) →
// disconnected (gone). The transition ALWAYS passes through reconnecting for RECONNECTING_WINDOW_MS, and
// that countdown RESTARTS on focus (focusedAt). Pure + clock-injected, so pin every boundary
// deterministically — the host re-announces every ~20s, so a healthy session sits inside CONNECTED_WINDOW_MS.
describe("connState", () => {
  const now = 1_000_000;
  const DISCONNECT_AT = CONNECTED_WINDOW_MS + RECONNECTING_WINDOW_MS; // stale→disconnected boundary (focusedAt=0)

  it("is connected for a fresh announce", () => {
    expect(connState(now, now)).toBe("connected"); // age 0
    expect(connState(now - 1, now)).toBe("connected");
    expect(connState(now - (CONNECTED_WINDOW_MS - 1), now)).toBe("connected");
  });

  it("is reconnecting for the full window once the announce goes stale (focusedAt unset)", () => {
    expect(connState(now - CONNECTED_WINDOW_MS, now)).toBe("reconnecting"); // exactly at the stale edge
    expect(connState(now - (DISCONNECT_AT - 1), now)).toBe("reconnecting"); // last ms before gone
  });

  it("is disconnected only at or past CONNECTED_WINDOW + RECONNECTING_WINDOW (focusedAt unset)", () => {
    expect(connState(now - DISCONNECT_AT, now)).toBe("disconnected"); // exactly at the edge
    expect(connState(now - (DISCONNECT_AT + 5_000), now)).toBe("disconnected");
    expect(connState(0, now)).toBe("disconnected");
  });

  it("restarts the disconnect countdown on focus: a long-stale announce reads reconnecting, not disconnected", () => {
    const staleAnnounce = now - 5 * 60_000; // 5 min old — would be 'disconnected' without focus
    // Just focused (we returned to the foreground this instant): show reconnecting for the full window
    // while the announce stream re-subscribes and a fresh announce lands.
    expect(connState(staleAnnounce, now, now)).toBe("reconnecting");
    // Still reconnecting at the last ms of the post-focus grace…
    expect(connState(staleAnnounce, now, now - (RECONNECTING_WINDOW_MS - 1))).toBe("reconnecting");
    // …then disconnected once the post-focus grace elapses with no fresh announce.
    expect(connState(staleAnnounce, now, now - RECONNECTING_WINDOW_MS)).toBe("disconnected");
  });

  it("always passes through reconnecting — never jumps connected→disconnected", () => {
    // Sweep the age across the whole ladder; assert no age yields 'disconnected' without 'reconnecting'
    // existing for the ages just before it.
    const ladder = Array.from({ length: 200 }, (_, i) => connState(now - i * 1_000, now));
    const firstDisc = ladder.indexOf("disconnected");
    expect(firstDisc).toBeGreaterThan(0);
    expect(ladder[firstDisc - 1]).toBe("reconnecting"); // the state immediately before gone is reconnecting
  });

  it("treats a future-stamped announce (clock skew) as connected, never negative", () => {
    expect(connState(now + 10_000, now)).toBe("connected"); // age < 0 → still inside the window
  });

  it("decouples the disconnect threshold from FRESH_WINDOW_MS (the control-verb replay bound)", () => {
    // At exactly FRESH_WINDOW_MS old the OLD model declared the host gone; the new ladder keeps it
    // reconnecting (FRESH_WINDOW_MS no longer gates the UI), so loosening disconnect can't widen replay.
    expect(connState(now - FRESH_WINDOW_MS, now)).toBe("reconnecting");
    expect(FRESH_WINDOW_MS).toBeLessThan(DISCONNECT_AT);
  });

  it("orders the windows so the ladder is monotone", () => {
    expect(CONNECTED_WINDOW_MS).toBeLessThan(DISCONNECT_AT);
    expect(RECONNECTING_WINDOW_MS).toBeGreaterThan(0);
  });
});

// The empty-transcript hint must DISTINGUISH a live-but-idle session from "still loading": a connected
// session with no turns yet should invite a prompt, not read as if content is still arriving.
describe("emptyTranscriptHint", () => {
  it("invites a prompt when connected + idle (not 'waiting for the transcript')", () => {
    const hint = emptyTranscriptHint("connected");
    expect(hint).toMatch(/no messages yet/i);
    expect(hint).toMatch(/prompt/i);
    expect(hint).not.toMatch(/waiting for the transcript/i);
  });

  it("reads as connecting before any announce (null)", () => {
    expect(emptyTranscriptHint(null)).toMatch(/connecting/i);
  });

  it("reflects a degraded host link distinctly from the idle/connecting states", () => {
    expect(emptyTranscriptHint("reconnecting")).toMatch(/reconnect/i);
    expect(emptyTranscriptHint("disconnected")).toMatch(/offline|reconnect/i);
    // every state yields a distinct message, so the empty pane is never ambiguous
    const all = ["connected", "reconnecting", "disconnected", null] as const;
    expect(new Set(all.map((s) => emptyTranscriptHint(s))).size).toBe(4);
  });
});

function ann(sentAt: number, mode?: string): Announce {
  const a: Announce = {
    sessionId: "s",
    title: "session",
    cwd: null,
    sentAt,
    incarnation: null,
    status: "",
    phase: "idle",
    needs: false,
    git: null,
  };
  if (mode !== undefined) a.mode = mode;
  return a;
}

describe("announce freshness merge", () => {
  it("drops a smaller sent_at announce that arrives after a larger one, but accepts equal timestamps", () => {
    const newest = ann(200, "plan");
    expect(shouldAcceptAnnounce(newest, ann(199, "default"))).toBe(false);
    expect(shouldAcceptAnnounce(newest, ann(200, "default"))).toBe(true);
    expect(shouldAcceptAnnounce(undefined, ann(1))).toBe(true);
  });
});

describe("permission mode display", () => {
  it("uses announced mode as the stable value and local optimistic mode only as an override", () => {
    expect(displayedPermissionMode("plan", null)).toBe("plan");
    expect(displayedPermissionMode("default", "auto")).toBe("auto");
    expect(displayedPermissionMode(undefined, null)).toBeNull();
  });
});

// parsePermissionResolved folds a logged permission_resolved frame back into {requestId, behavior} so
// a reload / catch_up renders the request resolved instead of re-prompting (#56). Tolerates bad JSON.
describe("parsePermissionResolved", () => {
  it("parses a well-formed allow", () => {
    expect(
      parsePermissionResolved(JSON.stringify({ request_id: "r1", behavior: "allow" })),
    ).toEqual({ requestId: "r1", behavior: "allow" });
  });

  it("parses a well-formed deny", () => {
    expect(parsePermissionResolved(JSON.stringify({ request_id: "r2", behavior: "deny" }))).toEqual(
      {
        requestId: "r2",
        behavior: "deny",
      },
    );
  });

  it("defaults an unknown/missing behavior to allow (the relay only emits allow|deny)", () => {
    expect(parsePermissionResolved(JSON.stringify({ request_id: "r3" })).behavior).toBe("allow");
    expect(
      parsePermissionResolved(JSON.stringify({ request_id: "r3", behavior: "weird" })).behavior,
    ).toBe("allow");
  });

  it("returns an empty requestId for a missing/non-string id or bad JSON (caller drops it)", () => {
    expect(parsePermissionResolved(JSON.stringify({ behavior: "deny" })).requestId).toBe("");
    expect(parsePermissionResolved(JSON.stringify({ request_id: 7 })).requestId).toBe("");
    expect(parsePermissionResolved("{not json").requestId).toBe("");
  });
});

// parseGit defensively coerces the announce's `git` field (decrypted-but-untrusted) into GitInfo|null
// — the viewer renders no chip rather than crashing on a malformed/absent body. (#49)
describe("parseGit", () => {
  it("parses a well-formed git snapshot", () => {
    expect(parseGit({ branch: "main", sha: "abc1234", dirty: true, ahead: 2, behind: 1 })).toEqual({
      branch: "main",
      sha: "abc1234",
      dirty: true,
      ahead: 2,
      behind: 1,
    });
  });

  it("returns null for null / non-object / a missing or empty branch", () => {
    expect(parseGit(null)).toBeNull();
    expect(parseGit(undefined)).toBeNull();
    expect(parseGit("main")).toBeNull();
    expect(parseGit({ sha: "abc" })).toBeNull(); // no branch
    expect(parseGit({ branch: "" })).toBeNull(); // empty branch
    expect(parseGit({ branch: 7 })).toBeNull(); // non-string branch
  });

  it("defaults missing/ill-typed fields (sha '', dirty false, ahead/behind 0)", () => {
    expect(parseGit({ branch: "x" })).toEqual({
      branch: "x",
      sha: "",
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    // non-finite / wrong-typed counts collapse to 0; dirty only true on a literal true
    expect(parseGit({ branch: "x", ahead: Number.NaN, behind: "5", dirty: "yes" })).toEqual({
      branch: "x",
      sha: "",
      dirty: false,
      ahead: 0,
      behind: 0,
    });
  });
});
