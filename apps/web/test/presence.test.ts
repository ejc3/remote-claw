import { describe, expect, it } from "vitest";
import { parsePermissionResolved } from "../app/lib/transcript.js";
import { CONNECTED_WINDOW_MS, connState, FRESH_WINDOW_MS } from "../app/lib/viewer.js";

// The connection-state ladder (#58): connected (fresh) → reconnecting (a keepalive or two missed) →
// disconnected (gone). Pure + clock-injected, so pin every boundary deterministically — the host
// re-announces every ~20s, so a healthy session sits well inside CONNECTED_WINDOW_MS.
describe("connState", () => {
  const now = 1_000_000;

  it("is connected for a fresh announce", () => {
    expect(connState(now, now)).toBe("connected"); // age 0
    expect(connState(now - 1, now)).toBe("connected");
    expect(connState(now - (CONNECTED_WINDOW_MS - 1), now)).toBe("connected");
  });

  it("is reconnecting once past the connected window but before the fresh window", () => {
    expect(connState(now - CONNECTED_WINDOW_MS, now)).toBe("reconnecting"); // exactly at the edge
    expect(connState(now - (FRESH_WINDOW_MS - 1), now)).toBe("reconnecting");
  });

  it("is disconnected at or past the fresh window", () => {
    expect(connState(now - FRESH_WINDOW_MS, now)).toBe("disconnected"); // exactly at the edge
    expect(connState(now - (FRESH_WINDOW_MS + 5_000), now)).toBe("disconnected");
    expect(connState(0, now)).toBe("disconnected");
  });

  it("treats a future-stamped announce (clock skew) as connected, never negative", () => {
    expect(connState(now + 10_000, now)).toBe("connected"); // age < 0 → still inside the window
  });

  it("orders the windows so the ladder is monotone", () => {
    expect(CONNECTED_WINDOW_MS).toBeLessThan(FRESH_WINDOW_MS);
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
