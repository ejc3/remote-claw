import type { SessionSettings, SessionSettingsChange } from "@remote-claw/cli/harness";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  canChooseNativeSetting,
  NativeSettingsSection,
  nativeSettingOutcome,
  type PendingNativeSetting,
  SessionSheet,
} from "../app/page.js";

const settings: SessionSettings = {
  models: [
    {
      id: "native-a",
      label: "Native A",
      defaultEffort: "balanced",
      efforts: [
        { id: "balanced", description: "Balance speed and thorough reasoning." },
        { id: "deep", description: "Spend more time reasoning through difficult tasks." },
      ],
    },
    {
      id: "native-b",
      label: "Native B",
      defaultEffort: "quick",
      efforts: [{ id: "quick", description: "Respond quickly." }],
    },
  ],
  collaborationModes: [
    { id: "ordinary", label: "Work" },
    { id: "proposal", label: "Plan together" },
  ],
  current: { model: "native-a", effort: "balanced", collaborationMode: "ordinary" },
};
const render = (
  snapshot: SessionSettings | null = settings,
  options: { pending?: boolean; connected?: boolean; notice?: string } = {},
) =>
  renderToStaticMarkup(
    createElement(NativeSettingsSection, {
      settings: snapshot,
      pending: options.pending ?? false,
      connected: options.connected ?? true,
      notice: options.notice ?? null,
      onChange: () => {},
    }),
  );

describe("native session settings", () => {
  it("uses the native catalog and descriptions, with only native-current selections ticked", () => {
    const html = render();
    expect(html).toContain('aria-label="Model: Native B"');
    expect(html).toContain('aria-label="Effort: deep"');
    expect(html).toContain("Spend more time reasoning through difficult tasks.");
    const descriptionId = html.match(/aria-label="Effort: deep" aria-describedby="([^"]+)"/)?.[1];
    expect(descriptionId).toBeTruthy();
    expect(html).toContain(
      `id="${descriptionId}">Spend more time reasoning through difficult tasks.`,
    );
    expect(html).toContain('aria-label="Mode: Plan together"');
    expect(html).toContain("Changing mode keeps the current model and effort.");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html).not.toContain("Respond quickly."); // another model's efforts are not offered
    expect(html).not.toContain("Opus");
  });

  it("keeps the old ticks and disables all choices while native confirmation is pending", () => {
    const html = render(settings, { pending: true });
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(6);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html).toContain("Waiting for native confirmation…");
    expect(html).not.toContain("Native settings confirmed.");
  });

  it("keeps native values readable offline without allowing mutation", () => {
    const html = render(settings, { connected: false });
    expect(html).toContain("Current: Native A");
    expect(html).toContain("Reconnect to the host before changing settings.");
    expect(
      (html.match(/<button\b[^>]*>/g) ?? []).every((button) => button.includes('disabled=""')),
    ).toBe(true);
  });

  it("displays unknown native values without manufacturing selectable options", () => {
    const html = render({
      ...settings,
      current: { model: "external-model", effort: "external-effort", collaborationMode: null },
    });
    expect(html).toContain("Current: external-model");
    expect(html).toContain("Current: external-effort");
    expect(html).toContain("Current: Unknown");
    expect(html).not.toContain('aria-label="Model: external-model"');
    expect(html).not.toContain('aria-label="Effort: external-effort"');
    expect(html).toContain("Confirm a supported model and effort before changing mode.");
    expect(
      (html.match(/<button\b[^>]*aria-label="Mode:[^>]*>/g) ?? []).every((button) =>
        button.includes('disabled=""'),
      ),
    ).toBe(true);
  });

  it("hides unsupported collaboration controls and missing catalogs", () => {
    expect(render({ ...settings, collaborationModes: [] })).not.toContain("Collaboration mode");
    expect(render(null)).not.toContain("<button");
    expect(render(null)).toContain("Native settings are not available yet.");
  });

  it("labels qualified model-only choices honestly and hides absent controls", () => {
    const qualified: SessionSettings = {
      modelChoicesSource: "qualified",
      models: [{ id: "verified", label: "Verified model", defaultEffort: null, efforts: [] }],
      collaborationModes: [],
      current: { model: "native-other", effort: null, collaborationMode: null },
    };
    const html = render(qualified);
    expect(html).toContain("Verified choices (not the full native catalog)");
    expect(html).toContain("Last confirmed model: native-other");
    expect(html).not.toContain("Reasoning effort");
    expect(html).not.toContain("Collaboration mode");
    expect(html).not.toContain('aria-pressed="true"');
    expect(canChooseNativeSetting(qualified, { model: "verified" })).toBe(true);
    expect(canChooseNativeSetting(qualified, { effort: "high" })).toBe(false);
    expect(canChooseNativeSetting(qualified, { collaborationMode: "plan" })).toBe(false);
  });

  it("exposes unconfirmed feedback as a status without changing selections", () => {
    const html = render(settings, {
      notice: "Change unconfirmed. Check the current native settings before trying again.",
    });
    expect(html).toContain('role="status"');
    expect(html).toContain("Change unconfirmed.");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
  });

  it("replaces legacy aliases only when the sheet receives native capabilities", () => {
    const props = {
      sessionTitle: "Native session",
      agentLabel: "Native agent",
      connectionLabel: "Connected",
      permissionLabel: "Approvals stay native",
      branch: null,
      currentModel: "opus",
      canModel: true,
      canInterrupt: false,
      hostConnected: true,
      onModel: () => {},
      onInterrupt: () => {},
      onCopyBranch: () => {},
      onClose: () => {},
    };
    const html = renderToStaticMarkup(
      createElement(SessionSheet, {
        ...props,
        nativeSettings: { settings, pending: false, notice: null, onChange: () => {} },
      }),
    );
    expect(html).toContain("Native A");
    expect(html).not.toContain("Opus");
    expect(html).toContain("Approvals stay native");
    expect(renderToStaticMarkup(createElement(SessionSheet, props))).toContain("Opus");
  });
});

describe("native selection validation and confirmation", () => {
  it("admits only a changed catalog value, and efforts belonging to the current model", () => {
    expect(canChooseNativeSetting(settings, { model: "native-b" })).toBe(true);
    expect(canChooseNativeSetting(settings, { effort: "deep" })).toBe(true);
    expect(canChooseNativeSetting(settings, { collaborationMode: "proposal" })).toBe(true);
    for (const change of [
      { model: "native-a" },
      { model: "missing" },
      { effort: "quick" },
      { effort: "balanced" },
      { collaborationMode: "missing" },
    ] as SessionSettingsChange[]) {
      expect(canChooseNativeSetting(settings, change)).toBe(false);
    }
  });

  it.each([
    null,
    "unsupported",
  ])("does not change mode with unconfirmed or unsupported effort %s", (effort) => {
    expect(
      canChooseNativeSetting(
        { ...settings, current: { ...settings.current, effort } },
        { collaborationMode: "proposal" },
      ),
    ).toBe(false);
  });

  const pending = (change: SessionSettingsChange): PendingNativeSetting => ({
    change,
    before: settings.current,
    deadline: 60_000,
  });
  it("waits through unchanged announcements then confirms exact native state", () => {
    expect(nativeSettingOutcome(pending({ model: "native-b" }), settings.current, 1000)).toBe(
      "pending",
    );
    expect(
      nativeSettingOutcome(
        pending({ model: "native-b" }),
        { ...settings.current, model: "native-b", effort: "quick" },
        1000,
      ),
    ).toBe("confirmed");
    expect(
      nativeSettingOutcome(
        pending({ effort: "deep" }),
        { ...settings.current, effort: "deep" },
        1000,
      ),
    ).toBe("confirmed");
    expect(
      nativeSettingOutcome(
        pending({ collaborationMode: "proposal" }),
        { ...settings.current, collaborationMode: "proposal" },
        1000,
      ),
    ).toBe("confirmed");
  });

  it("reports competing changes and the bounded timeout as unconfirmed", () => {
    expect(
      nativeSettingOutcome(
        pending({ model: "native-b" }),
        { ...settings.current, model: "external" },
        1000,
      ),
    ).toBe("unconfirmed");
    expect(
      nativeSettingOutcome(
        pending({ effort: "deep" }),
        { ...settings.current, model: "native-b", effort: "deep" },
        1000,
      ),
    ).toBe("unconfirmed");
    expect(
      nativeSettingOutcome(
        pending({ collaborationMode: "proposal" }),
        { ...settings.current, collaborationMode: "proposal", effort: "deep" },
        1000,
      ),
    ).toBe("unconfirmed");
    expect(nativeSettingOutcome(pending({ model: "native-b" }), settings.current, 59_999)).toBe(
      "pending",
    );
    expect(nativeSettingOutcome(pending({ model: "native-b" }), settings.current, 60_000)).toBe(
      "unconfirmed",
    );
  });
});
