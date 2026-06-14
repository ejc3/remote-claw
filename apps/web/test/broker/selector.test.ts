import { describe, expect, it } from "vitest";
import { backendSelector, isRequestableBackend } from "../../lib/broker";

// Sel-400: a BLANK selector (`?backend=`, whitespace, or an empty header) must read as NO selection
// (null) so the route's `requested !== null && !isRequestableBackend(requested)` guard falls through to
// the BROKER_BACKEND default — matching getBackend's own `trim() || default`. Before the fix, a blank
// `?backend=` was non-null but not requestable, so the relay/stream/seq routes 400'd a benign URL.

function sel(qs: string, header?: string): string | null {
  const url = new URL(`http://x/api/stream${qs}`);
  const init: RequestInit = header !== undefined ? { headers: { "x-broker-backend": header } } : {};
  return backendSelector(new Request(url, init), url);
}

describe("backendSelector blank handling (Sel-400)", () => {
  it("returns null for a blank / whitespace ?backend= (→ route uses the default, not a 400)", () => {
    expect(sel("?backend=")).toBeNull();
    expect(sel("?backend=%20%20")).toBeNull();
  });

  it("returns null for an empty / whitespace header", () => {
    expect(sel("", "")).toBeNull();
    expect(sel("", "   ")).toBeNull();
  });

  it("returns null when neither selector is present", () => {
    expect(sel("")).toBeNull();
  });

  it("returns the trimmed value for a real selector (param wins over header)", () => {
    expect(sel("?backend=sqlite")).toBe("sqlite");
    expect(sel("?backend=%20sqlite%20")).toBe("sqlite");
    expect(sel("?backend=sqlite", "vercel")).toBe("sqlite");
    expect(sel("", "vercel")).toBe("vercel");
  });

  it("an explicit empty ?backend= shadows the header (param wins) → null → default", () => {
    // A present-but-empty param explicitly means 'no backend' and beats the header — consistent with
    // 'param wins'. Both resolve to null so the route uses the BROKER_BACKEND default.
    expect(sel("?backend=", "sqlite")).toBeNull();
  });
});

describe("isRequestableBackend (the route guard a real invalid value still hits)", () => {
  it("rejects unknown names so a bad selector still 400s (Sel-400 didn't widen this)", () => {
    expect(isRequestableBackend("bogus")).toBe(false);
    // temporal was removed as a backend — a stale `?backend=temporal` must now 400, not resolve.
    expect(isRequestableBackend("temporal")).toBe(false);
  });

  it("accepts the requestable durable/shared backends", () => {
    expect(isRequestableBackend("sqlite")).toBe(true);
    expect(isRequestableBackend("vercel")).toBe(true);
  });
});
