import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home, { Connect, entryFromFragment, Pairing } from "../app/page.js";

// Restore-on-load (#110): a plain reload should restore the stored credential and land back in the
// console — NOT flash the pass/token form. These cover the pure load-time ROUTING (entryFromFragment)
// and the initial render (the splash), so a returning user never sees the pass form on reload. (Named
// for what it tests — load-time credential restore — not "reconnect", which is the network-stream
// re-subscribe exercised by the browser revive spec in tests/web/app-e2e/revive.spec.ts.)
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

describe("Pairing screen (decluttered)", () => {
  it("renders a trimmed one-time-link note + a quiet manual-entry link (not a white button)", () => {
    const html = renderToStaticMarkup(
      createElement(Pairing, { otk: "otk1_x", onConnect: () => {}, onCancel: () => {} }),
    );
    expect(html).toContain("Pair this device");
    expect(html).toContain("one-time");
    expect(html).toContain('class="btn-link"'); // the manual-entry is the quiet link, not a primary .btn
    expect(html).toContain("Enter a pass manually instead");
    expect(html).not.toContain("It can be claimed once and expires shortly"); // verbose copy trimmed
  });
});

describe("Connect screen (decluttered)", () => {
  it("keeps the essentials but drops the verbose reassurance paragraphs", () => {
    const html = renderToStaticMarkup(
      createElement(Connect, {
        pass: "",
        setPass: () => {},
        connect: () => {},
        connecting: false,
        error: null,
      }),
    );
    expect(html).toContain("end-to-end encrypted");
    expect(html).toContain("--rc-pass");
    expect(html).not.toContain("The broker never sees"); // trimmed for a less crowded entry screen
    expect(html).not.toContain("not the master secret"); // trimmed
  });
});
