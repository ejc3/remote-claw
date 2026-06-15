import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home, { entryFromFragment } from "../app/page.js";

// Auto-reconnect on reload (#110): a plain reload should restore the stored credential and reconnect,
// landing back in the console — NOT flash the pass/token form. These cover the pure load-time routing
// and the initial render (the splash), so a returning user never sees the pass form on reload.
describe("entryFromFragment (load-time routing)", () => {
  it("classifies a legacy bare pass", () => {
    expect(entryFromFragment("rcp1_ABC")).toEqual({ kind: "pass", value: "rcp1_ABC" });
  });
  it("classifies a one-time handoff token", () => {
    expect(entryFromFragment("otk1_XYZ")).toEqual({ kind: "handoff", value: "otk1_XYZ" });
  });
  it("falls back to restore (auto-reconnect) for an empty/unknown fragment", () => {
    expect(entryFromFragment("")).toEqual({ kind: "restore" });
    expect(entryFromFragment("notatoken")).toEqual({ kind: "restore" });
  });
});

describe("Home initial render", () => {
  it("shows the reconnecting splash on first paint, not the pass form (no token-form flash)", () => {
    // SSR/initial render: effects haven't run, restoring=true → the splash. This is what a returning
    // user sees on reload before the stored credential auto-reconnects.
    const html = renderToStaticMarkup(createElement(Home));
    expect(html).toContain("Connecting…");
    expect(html).not.toContain("rcp1_…"); // the Connect form's placeholder must NOT be shown
    expect(html).not.toContain("Drive your claude"); // nor the Connect headline
  });
});
