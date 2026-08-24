import { describe, expect, it } from "vitest";
import { parsePermissionResolved } from "../app/lib/transcript.js";
import {
  ANNOUNCE_FUTURE_SKEW_MS,
  type Announce,
  announceFreshnessAt,
  CONNECTED_WINDOW_MS,
  connState,
  emptyTranscriptHint,
  FRESH_WINDOW_MS,
  nextReconnectAnchor,
  parseCapabilities,
  parseGit,
  parseHarness,
  RECONNECTING_WINDOW_MS,
  shouldAcceptAnnounce,
} from "../app/lib/viewer.js";
import {
  displayedPermissionMode,
  markPendingDeliveryUnknown,
  optimisticMessage,
  remoteMutationEnabled,
} from "../app/page.js";

// The connection-state ladder (#58): connected (fresh) → reconnecting (full grace window) →
// disconnected (gone). The transition ALWAYS passes through reconnecting for RECONNECTING_WINDOW_MS. The
// countdown is anchored at `reconnectingSince` — set ONCE when an announce first reads stale (after a
// returning tab, the return instant) via nextReconnectAnchor, NOT re-reset by focus, so a dead host still
// reaches disconnected. Pure + clock-injected, so pin every boundary deterministically.
describe("connState", () => {
  const now = 1_000_000;
  const DISCONNECT_AT = CONNECTED_WINDOW_MS + RECONNECTING_WINDOW_MS; // stale→disconnected boundary (anchor unset)

  it("is connected for a fresh announce", () => {
    expect(connState(now, now)).toBe("connected"); // age 0
    expect(connState(now - 1, now)).toBe("connected");
    expect(connState(now - (CONNECTED_WINDOW_MS - 1), now)).toBe("connected");
  });

  it("is reconnecting for the full window once the announce goes stale (anchor unset → staleAt)", () => {
    expect(connState(now - CONNECTED_WINDOW_MS, now)).toBe("reconnecting"); // exactly at the stale edge
    expect(connState(now - (DISCONNECT_AT - 1), now)).toBe("reconnecting"); // last ms before gone
  });

  it("is disconnected only at or past CONNECTED_WINDOW + RECONNECTING_WINDOW (anchor unset)", () => {
    expect(connState(now - DISCONNECT_AT, now)).toBe("disconnected"); // exactly at the edge
    expect(connState(now - (DISCONNECT_AT + 5_000), now)).toBe("disconnected");
    expect(connState(0, now)).toBe("disconnected");
  });

  it("anchors the countdown at the reconnect attempt: a long-stale announce reads reconnecting right after the anchor is set", () => {
    const staleAnnounce = now - 5 * 60_000; // 5 min old — 'disconnected' on the bare ladder
    // Anchor just set (a tab returned this instant): reconnecting for the full window while the
    // re-subscribe pulls a fresh announce.
    expect(connState(staleAnnounce, now, now)).toBe("reconnecting");
    expect(connState(staleAnnounce, now, now - (RECONNECTING_WINDOW_MS - 1))).toBe("reconnecting");
    // …then disconnected once the window elapses with no fresh announce.
    expect(connState(staleAnnounce, now, now - RECONNECTING_WINDOW_MS)).toBe("disconnected");
  });

  it("a DEAD host reaches disconnected despite repeated focus — the anchor is set once, never re-reset", () => {
    // Regression guard for the audit's blocking finding: refocusing every 25s (< window) must NOT hold a
    // dead host at 'reconnecting' forever. Model the UI: the anchor is fixed at first staleness; focus only
    // advances `now` (it does NOT move the anchor — that's nextReconnectAnchor's contract, asserted below).
    const staleAnnounce = now - 5 * 60_000;
    const anchor = nextReconnectAnchor(undefined, true, now); // first stale observation (e.g. on return)
    expect(anchor).toBe(now);
    // Repeated focus at +25s, +50s, +75s … each only advances the clock; the anchor stays put.
    for (const dt of [25_000, 50_000, 75_000, 120_000]) {
      const t = now + dt;
      // The UI re-applies nextReconnectAnchor on each render; while stale it must keep the SAME anchor.
      expect(nextReconnectAnchor(anchor, true, t)).toBe(anchor);
      const cs = connState(staleAnnounce, t, anchor as number);
      if (dt < RECONNECTING_WINDOW_MS) expect(cs).toBe("reconnecting");
      else expect(cs).toBe("disconnected"); // dead host DOES surface, despite the refocuses
    }
  });

  it("always passes through reconnecting — never jumps connected→disconnected", () => {
    const ladder = Array.from({ length: 200 }, (_, i) => connState(now - i * 1_000, now));
    const firstDisc = ladder.indexOf("disconnected");
    expect(firstDisc).toBeGreaterThan(0);
    expect(ladder[firstDisc - 1]).toBe("reconnecting"); // the state immediately before gone is reconnecting
  });

  it("disconnects after the bounded receipt window even when the host clock is in the future", () => {
    const futureHostTimestamp = now + 24 * 60 * 60_000;
    const freshnessAt = announceFreshnessAt(undefined, ann(futureHostTimestamp), now);
    expect(freshnessAt).toBe(now - CONNECTED_WINDOW_MS);
    expect(connState(freshnessAt, now)).toBe("reconnecting");
    const state = connState(freshnessAt, now + RECONNECTING_WINDOW_MS);
    expect(state).toBe("disconnected");
    expect(remoteMutationEnabled(state === "connected")).toBe(false);
    expect(
      markPendingDeliveryUnknown([optimisticMessage("cm-future", "hello", [])])[0],
    ).toMatchObject({ deliveryUnknown: true });
    expect(emptyTranscriptHint(state)).toMatch(/offline|reconnect/i);

    // A brand-new Viewer after a reload has no accepted-announcement cache. The same retained frame
    // still starts non-writable instead of receiving a fresh 45-second lease from the new receipt.
    const reloadAt = now + CONNECTED_WINDOW_MS + RECONNECTING_WINDOW_MS;
    const reloadedFreshness = announceFreshnessAt(undefined, ann(futureHostTimestamp), reloadAt);
    expect(connState(reloadedFreshness, reloadAt)).toBe("reconnecting");
    expect(remoteMutationEnabled(connState(reloadedFreshness, reloadAt) === "connected")).toBe(
      false,
    );
  });

  it("allows bounded positive skew and a corrected new keepalive to recover liveness", () => {
    const withinSkew = ann(now + ANNOUNCE_FUTURE_SKEW_MS);
    expect(connState(announceFreshnessAt(undefined, withinSkew, now), now)).toBe("connected");

    const invalid = {
      ...ann(now + 86_400_000),
      incarnation: "inc-clock",
      incarnationStartedAt: now,
      announceSeq: 1,
    };
    invalid.freshnessAt = announceFreshnessAt(undefined, invalid, now);
    const correctedReceipt = now + 20_000;
    const corrected = { ...invalid, sentAt: correctedReceipt, announceSeq: 2 };
    expect(
      connState(announceFreshnessAt(invalid, corrected, correctedReceipt), correctedReceipt),
    ).toBe("connected");
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

// nextReconnectAnchor: set the per-session reconnect anchor ONCE while stale, clear when connected, and
// NEVER re-reset while it stays stale (the audit's blocking fix — repeated focus must not mask a dead host).
describe("nextReconnectAnchor", () => {
  const now = 1_000_000;
  it("sets the anchor to `now` when first stale (no prior anchor)", () => {
    expect(nextReconnectAnchor(undefined, true, now)).toBe(now);
  });
  it("holds the existing anchor while it stays stale — focus/ticks never move it", () => {
    expect(nextReconnectAnchor(now, true, now + 25_000)).toBe(now);
    expect(nextReconnectAnchor(now, true, now + 999_999)).toBe(now);
  });
  it("clears the anchor once connected (not stale), so the next stale period re-anchors fresh", () => {
    expect(nextReconnectAnchor(now, false, now + 10_000)).toBeUndefined();
    // …and a subsequent staleness gets a new anchor at that later time
    expect(nextReconnectAnchor(undefined, true, now + 50_000)).toBe(now + 50_000);
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
    freshnessAt: sentAt,
    incarnation: null,
    incarnationStartedAt: null,
    announceSeq: null,
    status: "",
    phase: "idle",
    needs: false,
    git: null,
  };
  if (mode !== undefined) a.mode = mode;
  return a;
}

describe("announce freshness merge", () => {
  it("refreshes on a proven new keepalive but not on an exact legacy replay", () => {
    const receivedAt = 1_000;
    const firstLegacy = ann(receivedAt + 86_400_000);
    firstLegacy.freshnessAt = announceFreshnessAt(undefined, firstLegacy, receivedAt);
    const replay = ann(firstLegacy.sentAt);
    expect(announceFreshnessAt(firstLegacy, replay, receivedAt + 240_000)).toBe(
      firstLegacy.freshnessAt,
    );

    const current = {
      ...ann(receivedAt),
      incarnation: "inc-1",
      incarnationStartedAt: 1,
      announceSeq: 1,
    };
    current.freshnessAt = announceFreshnessAt(undefined, current, receivedAt);
    const keepalive = { ...current, sentAt: receivedAt + 20_000, announceSeq: 2 };
    expect(announceFreshnessAt(current, keepalive, receivedAt + 20_000)).toBe(receivedAt + 20_000);
  });

  it("keeps legacy timestamp behavior, including equal-timestamp replacement", () => {
    const newest = ann(200, "plan");
    expect(shouldAcceptAnnounce(newest, ann(199, "default"))).toBe(false);
    expect(shouldAcceptAnnounce(newest, ann(200, "default"))).toBe(true);
    expect(shouldAcceptAnnounce(undefined, ann(1))).toBe(true);
  });

  it("uses announce_seq to converge when same-incarnation requests arrive in reverse order", () => {
    const older = {
      ...ann(200, "default"),
      incarnation: "inc-1",
      incarnationStartedAt: 100,
      announceSeq: 4,
    };
    const newer = { ...older, mode: "plan", announceSeq: 5 };

    expect(shouldAcceptAnnounce(older, newer)).toBe(true);
    expect(shouldAcceptAnnounce(newer, older)).toBe(false);
  });

  it("accepts a newer incarnation and cannot flip back to an older one", () => {
    const oldIncarnation = {
      ...ann(300, "default"),
      incarnation: "inc-old",
      incarnationStartedAt: 100,
      announceSeq: 9,
    };
    const newIncarnation = {
      ...ann(300, "plan"),
      incarnation: "inc-new",
      incarnationStartedAt: 200,
      announceSeq: 0,
    };
    const delayedOld = { ...oldIncarnation, sentAt: 400, announceSeq: 10 };

    // Equal sent_at does not block a normal forward restart; once accepted, even an old frame with a
    // later wall timestamp cannot retire the newer incarnation.
    expect(shouldAcceptAnnounce(oldIncarnation, newIncarnation)).toBe(true);
    expect(shouldAcceptAnnounce(newIncarnation, delayedOld)).toBe(false);
  });

  it("uses a stable incarnation-id tie-break when distinct incarnations have equal starts", () => {
    const loser = {
      ...ann(200),
      incarnation: "inc-a",
      incarnationStartedAt: 100,
      announceSeq: 1,
    };
    const winner = {
      ...ann(100),
      incarnation: "inc-z",
      incarnationStartedAt: 100,
      announceSeq: 0,
    };
    const delayedLoser = { ...loser, sentAt: 500, announceSeq: 2 };

    // The lexical winner is accepted even with an older sent_at. Once accepted, the loser cannot
    // flip state back despite a later sent_at; this is a stable order, not proof of chronology.
    expect(shouldAcceptAnnounce(loser, winner)).toBe(true);
    expect(shouldAcceptAnnounce(winner, delayedLoser)).toBe(false);
  });

  it("fails stable on a clock-regressed incarnation even when its sent_at is newer", () => {
    const accepted = {
      ...ann(200),
      incarnation: "inc-a",
      incarnationStartedAt: 200,
      announceSeq: 5,
    };
    const regressed = {
      ...ann(300),
      incarnation: "inc-b",
      incarnationStartedAt: 100,
      announceSeq: 0,
    };

    expect(shouldAcceptAnnounce(accepted, regressed)).toBe(false);
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

// parseCapabilities defensively coerces the announce's `capabilities` field (decrypted-but-untrusted)
// into Capabilities|undefined. Absent/malformed → undefined so the viewer treats a legacy host as fully
// capable (no false gating). A present vector's status defaults false so an absent/ill-typed status
// cannot satisfy the exact stable-Claude tuple; missing mutation booleans stay enabled, so a partial
// vector remains on the compatibility surface and only an explicit false disables a mutation. (#149)
describe("parseCapabilities", () => {
  it("parses a well-formed reduced capability set verbatim", () => {
    expect(
      parseCapabilities({
        structuredPermissions: false,
        status: true,
        controls: { interrupt: true, setModel: false, setMode: false, end: false },
        attachments: true,
      }),
    ).toEqual({
      structuredPermissions: false,
      status: true,
      controls: { interrupt: true, setModel: false, setMode: false, end: false },
      attachments: true,
    });
  });

  it("returns undefined for null / non-object (a legacy host → full capability assumed)", () => {
    expect(parseCapabilities(null)).toBeUndefined();
    expect(parseCapabilities(undefined)).toBeUndefined();
    expect(parseCapabilities("nope")).toBeUndefined();
  });

  it("fails missing/ill-typed status closed while mutation flags remain compatibility-enabled", () => {
    expect(parseCapabilities({})).toEqual({
      structuredPermissions: true,
      status: false,
      controls: { interrupt: true, setModel: true, setMode: true, end: true },
      attachments: true,
    });
    expect(parseCapabilities({ status: "ready" })?.status).toBe(false);
    // a malformed controls object still yields all-enabled controls
    expect(parseCapabilities({ controls: "bad", setMode: 1 })?.controls).toEqual({
      interrupt: true,
      setModel: true,
      setMode: true,
      end: true,
    });
  });

  it("only flips the controls a driver explicitly declares false", () => {
    const caps = parseCapabilities({ controls: { setMode: false } });
    expect(caps?.controls).toEqual({
      interrupt: true,
      setModel: true,
      setMode: false,
      end: true,
    });
  });
});

// parseHarness coerces the announce's `harness` (decrypted-but-untrusted) into the agent+mode label the
// session list shows (#164). Unknown enums / malformed bodies → undefined so the viewer falls back to the
// MITM label (a legacy host is always native-RC Claude Code) rather than mislabeling.
describe("parseHarness", () => {
  it("parses each known agent+mode verbatim", () => {
    expect(parseHarness({ agent: "claude-code", mode: "rc" })).toEqual({
      agent: "claude-code",
      mode: "rc",
    });
    expect(parseHarness({ agent: "claude-code", mode: "tmux" })).toEqual({
      agent: "claude-code",
      mode: "tmux",
    });
    expect(parseHarness({ agent: "opencode", mode: "opencode" })).toEqual({
      agent: "opencode",
      mode: "opencode",
    });
  });

  it("returns undefined for a legacy host (absent) or a non-object", () => {
    expect(parseHarness(undefined)).toBeUndefined();
    expect(parseHarness(null)).toBeUndefined();
    expect(parseHarness("nope")).toBeUndefined();
  });

  it("returns undefined for an unknown agent or mode (never mislabels)", () => {
    expect(parseHarness({ agent: "gemini", mode: "rc" })).toBeUndefined();
    expect(parseHarness({ agent: "claude-code", mode: "ssh" })).toBeUndefined();
    expect(parseHarness({ agent: "claude-code" })).toBeUndefined(); // missing mode
    expect(parseHarness({ mode: "rc" })).toBeUndefined(); // missing agent
  });

  it("rejects an enum-valid but nonsensical PAIR (matches the whole descriptor, not each field)", () => {
    // Both fields are individually valid enums, but the COMBO is not one a host announces — it must fall
    // back to the MITM label, never be mislabelled (e.g. as "Claude Code · RC"). codex.
    expect(parseHarness({ agent: "claude-code", mode: "opencode" })).toBeUndefined();
    expect(parseHarness({ agent: "opencode", mode: "rc" })).toBeUndefined();
    expect(parseHarness({ agent: "opencode", mode: "tmux" })).toBeUndefined();
  });
});
