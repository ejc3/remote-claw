import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionSheet } from "../app/page.js";

// Session ⋯ sheet (#111): model switcher (set_model) + interrupt + copy-branch.
const render = (branch: string | null, currentModel: string | null = null) =>
  renderToStaticMarkup(
    createElement(SessionSheet, {
      branch,
      currentModel,
      onModel: () => {},
      onInterrupt: () => {},
      onCopyBranch: () => {},
      onClose: () => {},
    }),
  );

describe("SessionSheet", () => {
  it("offers the model switcher (Default/Opus/Sonnet/Haiku) + Interrupt", () => {
    const html = render("main");
    expect(html).toContain("Change model");
    for (const m of ["Default", "Opus", "Sonnet", "Haiku"]) expect(html).toContain(m);
    expect(html).toContain("Interrupt");
  });

  it("shows Copy branch with the branch name when in a repo", () => {
    const html = render("feat/x");
    expect(html).toContain("Copy branch");
    expect(html).toContain("feat/x");
  });

  it("hides Copy branch outside a repo (no git), but keeps Interrupt", () => {
    const html = render(null);
    expect(html).not.toContain("Copy branch");
    expect(html).toContain("Interrupt");
  });

  // #design-pass: the model sheet previously rendered four identical rows with no indication of the
  // active model. With a chosen model it must tick exactly that row (aria-pressed + a check).
  it("ticks the currently-selected model (aria-pressed + check), and nothing when none chosen", () => {
    const none = render("main", null);
    expect(none).not.toContain('aria-pressed="true"');

    const opus = render("main", "opus");
    // exactly one row is pressed/active
    expect(opus.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(opus.match(/data-active="true"/g)?.length).toBe(1);
    // and it's the Opus row (the check ✓ is rendered)
    expect(opus).toContain("✓");
  });

  // #design-pass: Interrupt is destructive and must read differently from the benign model/branch rows
  // so it isn't mis-tapped.
  it("styles Interrupt as a destructive row", () => {
    const html = render("main");
    expect(html).toContain("mode-row-danger");
  });
});
