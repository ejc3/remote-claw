import { describe, expect, it } from "vitest";
import { parseSessionSettings } from "../../../harness.js";
import { claudeModelSettings, isClaudeSessionModel } from "./settings.js";

const choices = [
  ["claude-opus-5[1m]", "Opus 5 (1M context)"],
  ["claude-fable-5", "Fable 5"],
  ["claude-sonnet-5", "Sonnet 5"],
  ["claude-sonnet-4-6", "Sonnet 4.6"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5"],
] as const;

describe("qualified Claude session models", () => {
  it.each(choices)("offers and accepts exactly qualified model %s", (id) => {
    expect(isClaudeSessionModel(id)).toBe(true);
    const settings = claudeModelSettings(id);
    expect(settings).toEqual({
      modelChoicesSource: "qualified",
      models: choices.map(([model, label]) => ({
        id: model,
        label,
        defaultEffort: null,
        efforts: [],
      })),
      collaborationModes: [],
      current: { model: id, effort: null, collaborationMode: null },
    });
    expect(parseSessionSettings(settings)).toEqual(settings);
  });

  it.each([
    "default",
    "opus",
    "opus[1m]",
    "sonnet",
    "haiku",
    "claude-opus-5",
    "claude-fable-5[1m]",
    "claude-opus-5.5",
    "claude-fable-5.1",
    "claude-sonnet-5 ",
    "arbitrary-model",
    "",
    null,
    undefined,
    5,
    {},
  ])("rejects aliases, resets and unqualified request value %j", (value) => {
    expect(isClaudeSessionModel(value)).toBe(false);
  });

  it("keeps an unknown native current model visible without authorizing it", () => {
    const settings = claudeModelSettings("native-custom-model");
    expect(settings?.current.model).toBe("native-custom-model");
    expect(settings?.models.some((model) => model.id === "native-custom-model")).toBe(false);
    expect(isClaudeSessionModel(settings?.current.model)).toBe(false);
  });

  it.each([
    null,
    undefined,
    1,
    "",
    "   ",
    "x".repeat(257),
  ])("requires a bounded current model before exposing choices %#", (model) => {
    expect(claudeModelSettings(model)).toBeNull();
  });
});
