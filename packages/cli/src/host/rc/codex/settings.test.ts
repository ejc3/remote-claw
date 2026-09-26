import { describe, expect, it } from "vitest";
import type { SessionSettings } from "../../../harness.js";
import {
  codexSettingsUpdate,
  parseCodexCurrentSettings,
  parseCodexModels,
  parseCodexModes,
  parseCodexResumeSettings,
  parseCodexSettingsUpdate,
} from "./settings.js";

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "picker-id",
    model: "model-slug",
    displayName: "Model",
    hidden: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "ultra", description: "Automatic task delegation" },
    ],
    ...overrides,
  };
}

const modes = [
  { mode: "plan", name: "Plan", reasoning_effort: "medium" },
  { mode: "default", name: "Default", reasoning_effort: null },
];
function settings(): SessionSettings {
  return {
    models: parseCodexModels([model()]) ?? [],
    collaborationModes: parseCodexModes(modes) ?? [],
    current: { model: "model-slug", effort: "ultra", collaborationMode: null },
  };
}

describe("Codex settings projection", () => {
  it("uses request slugs, preserves native effort descriptions and ignores preset effort hints", () => {
    expect(settings()).toMatchObject({
      models: [
        {
          id: "model-slug",
          defaultEffort: "low",
          efforts: [{ id: "low" }, { id: "ultra", description: "Automatic task delegation" }],
        },
      ],
      collaborationModes: [
        { id: "plan", label: "Plan" },
        { id: "default", label: "Default" },
      ],
    });
  });

  it.each(
    [
      [],
      Array(33).fill(model()),
      [model(), model()],
      [model({ model: "x".repeat(257) })],
      [model({ displayName: "x".repeat(257) })],
      [model({ hidden: true })],
      [model({ defaultReasoningEffort: "missing" })],
      [model({ supportedReasoningEfforts: [] })],
      [
        model({
          supportedReasoningEfforts: Array(13).fill({
            reasoningEffort: "low",
            description: "Fast",
          }),
        }),
      ],
      [
        model({
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "x".repeat(513) }],
        }),
      ],
    ].map((catalog) => ({ catalog })),
  )("rejects malformed/oversized/ambiguous model catalog %#", ({ catalog }) => {
    expect(parseCodexModels(catalog)).toBeNull();
  });

  it.each(
    [
      [],
      Array(9).fill(modes[0]),
      [modes[0], modes[0]],
      [{ mode: "custom", name: "Custom" }],
      [{ mode: "plan", name: "x".repeat(257) }],
    ].map((catalog) => ({ catalog })),
  )("rejects unsupported mode catalog %#", ({ catalog }) => {
    expect(parseCodexModes(catalog)).toBeNull();
  });

  it("keeps unknown native values visible and does not infer current mode from resume", () => {
    expect(
      parseCodexCurrentSettings({
        model: "native-model",
        effort: "native-effort",
        collaborationMode: { mode: "native-mode" },
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    ).toEqual({ model: "native-model", effort: "native-effort", collaborationMode: "native-mode" });
    expect(
      parseCodexResumeSettings({
        model: "model-slug",
        reasoningEffort: null,
        thread: { reasoningEffort: "stale", collaborationMode: "plan" },
      }),
    ).toEqual({ model: "model-slug", effort: null, collaborationMode: null });
    expect(parseCodexResumeSettings({ thread: {} })).toBeUndefined();
    expect(
      parseCodexCurrentSettings({
        model: "model-slug",
        effort: {},
        collaborationMode: { mode: "plan" },
      }),
    ).toBeNull();
  });

  it.each([
    "plan",
    "default",
  ])("changing %s preserves confirmed model and explicit Ultra effort", (mode) => {
    expect(codexSettingsUpdate({ collaborationMode: mode }, settings())).toEqual({
      collaborationMode: {
        mode,
        settings: { model: "model-slug", reasoning_effort: "ultra", developer_instructions: null },
      },
    });
  });

  it("whitelists model and effort separately without copying other settings", () => {
    expect(codexSettingsUpdate({ model: "model-slug" }, settings())).toEqual({
      model: "model-slug",
    });
    expect(codexSettingsUpdate({ effort: "low" }, settings())).toEqual({ effort: "low" });
    for (const change of [
      { model: "unknown" },
      { effort: "medium" },
      { collaborationMode: "custom" },
      { model: "model-slug", effort: "low" },
      { approvalPolicy: "never" },
    ])
      expect(codexSettingsUpdate(change, settings())).toBeNull();
    for (const current of [
      { model: "model-slug", effort: null, collaborationMode: null },
      { model: "unknown", effort: "ultra", collaborationMode: null },
    ])
      expect(
        codexSettingsUpdate({ collaborationMode: "plan" }, { ...settings(), current }),
      ).toBeNull();
  });

  it("rejects policy fields and arbitrary instructions at the final native client boundary", () => {
    const safe = codexSettingsUpdate({ collaborationMode: "plan" }, settings());
    expect(parseCodexSettingsUpdate(safe)).toEqual(safe);
    for (const raw of [
      { model: "model-slug", sandboxPolicy: { type: "dangerFullAccess" } },
      { effort: "low", approvalPolicy: "never" },
      {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "model-slug",
            reasoning_effort: "low",
            developer_instructions: "custom",
          },
        },
      },
      {
        collaborationMode: {
          mode: "plan",
          settings: { model: "model-slug", reasoning_effort: null, developer_instructions: null },
        },
      },
      {
        collaborationMode: {
          mode: "default",
          settings: {
            model: "model-slug",
            reasoning_effort: "low",
            developer_instructions: null,
            cwd: "/private",
          },
        },
      },
    ])
      expect(parseCodexSettingsUpdate(raw)).toBeNull();
  });
});
