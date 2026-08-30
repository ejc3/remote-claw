import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionSheet } from "../app/page.js";

// Session ⋯ sheet (#111): model switcher (set_model) + interrupt + copy-branch.
const render = (
  branch: string | null,
  currentModel: string | null = null,
  caps: { canModel?: boolean; canInterrupt?: boolean; hostConnected?: boolean } = {},
) =>
  renderToStaticMarkup(
    createElement(SessionSheet, {
      sessionTitle: "rc box",
      agentLabel: "Claude Code",
      connectionLabel: "Private relay",
      permissionLabel: "Permission prompts stay in the local terminal",
      branch,
      currentModel,
      canModel: caps.canModel ?? true,
      canInterrupt: caps.canInterrupt ?? true,
      hostConnected: caps.hostConnected ?? true,
      onModel: () => {},
      onInterrupt: () => {},
      onCopyBranch: () => {},
      onClose: () => {},
    }),
  );

describe("SessionSheet", () => {
  it("offers the model switcher (Default/Opus/Sonnet/Haiku) + Interrupt", () => {
    const html = render("main");
    expect(html).toContain("Model");
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
    // and the consistent icon vocabulary renders its check mark.
    expect(opus).toContain('data-icon="check"');
  });

  // #design-pass: Interrupt is destructive and must read differently from the benign model/branch rows
  // so it isn't mis-tapped.
  it("styles Interrupt as a destructive row", () => {
    const html = render("main");
    expect(html).toContain("mode-row-danger");
  });

  // #149 capability gating: a driver that can't switch model (opencode) gets the model rows replaced by
  // an explanatory note instead of buttons that silently no-op.
  it("replaces the model rows with a note when the driver can't switch model", () => {
    const html = render("main", null, { canModel: false });
    expect(html).toContain("Model"); // the section header stays
    expect(html).toContain("can’t switch model");
    expect(html).not.toContain("Opus"); // no model buttons rendered
    expect(html).toContain("Interrupt"); // other actions remain
  });

  // #149: Interrupt is disabled when the driver can't honor it (defensive — all current drivers can).
  it("disables Interrupt when the driver can't interrupt", () => {
    const html = render("main", null, { canInterrupt: false });
    expect(html).toContain("Not supported by this harness");
    // the destructive row carries a disabled attribute
    expect(html).toMatch(/mode-row-danger[^>]*disabled|disabled[^>]*mode-row-danger/);
  });

  it("keeps remote actions disabled and labels reconnection when host presence is stale", () => {
    const html = render("main", null, {
      canModel: false,
      canInterrupt: false,
      hostConnected: false,
    });
    expect(html).toContain("Reconnect to the host before changing model");
    expect(html).toContain("Reconnect to the host before interrupting");
    expect(html).toMatch(/mode-row-danger[^>]*disabled|disabled[^>]*mode-row-danger/);
  });
});
