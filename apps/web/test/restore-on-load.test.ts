import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home, { Connect, entryFromFragment, Pairing } from "../app/page.js";

// Restore-on-load (#110): a plain reload should restore the stored credential and land back in the
// console — NOT flash the pass/token form. These cover the pure load-time ROUTING (entryFromFragment)
// and the initial render (the splash), so a returning user never sees the pass form on reload. (Named
// for what it tests — load-time credential restore — not "reconnect", which is the network-stream
// re-subscribe exercised by the browser revive spec in tests/web/app-e2e/revive.spec.ts.)
/** The opening `<button …>` tag that ENCLOSES `text` in a static-markup string. Lets an assertion talk
 *  about "the button labelled X" without a DOM. Astryx's Button renders its label inside a nested
 *  <span>, so this walks out to the nearest preceding `<button`, not the immediate parent — and then
 *  verifies that button hasn't already closed before the text, so a PRECEDING SIBLING button can't be
 *  mistaken for the enclosing one (`<button data-variant="ghost"></button><span>text</span>` must not
 *  satisfy an assertion about the button around `text`). Returns "" when there is no enclosing button,
 *  which fails the positive assertions at the call site. */
function enclosingButtonTag(html: string, text: string): string {
  const at = html.indexOf(text);
  if (at < 0) return "";
  const open = html.lastIndexOf("<button", at);
  if (open < 0) return "";
  const close = html.indexOf("</button>", open);
  if (close >= 0 && close < at) return ""; // that button closed before the text — not our enclosing one
  return html.slice(open, html.indexOf(">", open) + 1);
}

describe("entryFromFragment (load-time routing)", () => {
  it("classifies a legacy bare pass", () => {
    expect(entryFromFragment("rcp1_ABC")).toEqual({ kind: "pass", value: "rcp1_ABC" });
  });
  it("denies a one-time handoff token by default", () => {
    expect(entryFromFragment("otk1_XYZ", false)).toEqual({ kind: "handoff-disabled" });
  });
  it("classifies a one-time handoff token when the deployment feature is enabled", () => {
    expect(entryFromFragment("otk1_XYZ", true)).toEqual({
      kind: "handoff",
      value: "otk1_XYZ",
    });
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
    expect(html).toContain("Enter a pass manually instead");
    // The manual-entry affordance stays the QUIET one — it must not become a second filled button
    // competing with "Pair this device". Astryx reflects a Button's variant as `data-variant` (its
    // documented selector surface), so assert that instead of the hand-written `.btn-link` class the
    // component replaced: the <button> wrapping this label is ghost, not primary.
    const manual = enclosingButtonTag(html, "Enter a pass manually instead");
    expect(manual).toContain('data-variant="ghost"');
    expect(manual).not.toContain('data-variant="primary"');
    expect(html).not.toContain("It can be claimed once and expires shortly"); // verbose copy trimmed
  });
});

describe("Connect screen", () => {
  it("keeps the entry gate concise while disclosing the pass's full authority", () => {
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
    expect(html).toContain('aria-describedby="machine-pass-authority"');
    expect(html).toContain('id="machine-pass-authority"');
    expect(html).toContain("Indefinite, machine-wide access");
    expect(html).not.toContain("The broker never sees"); // trimmed for a less crowded entry screen
  });
});
