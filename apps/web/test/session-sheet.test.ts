import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionSheet } from "../app/page.js";

// Session ⋯ sheet (#111): model switcher (set_model) + interrupt + copy-branch.
const render = (branch: string | null) =>
  renderToStaticMarkup(
    createElement(SessionSheet, {
      branch,
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
});
