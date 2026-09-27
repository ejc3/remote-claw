import type { SessionSettings } from "../../../harness.js";

/** Session-only RC writes qualified against exact Claude 2.1.237. Not a discovered native catalog. */
const qualifiedModels = [
  { id: "claude-opus-5[1m]", label: "Opus 5 (1M context)" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

export type ClaudeSessionModel = (typeof qualifiedModels)[number]["id"];

export function isClaudeSessionModel(value: unknown): value is ClaudeSessionModel {
  return qualifiedModels.some((model) => value === model.id);
}

export function claudeModelSettings(model: unknown): SessionSettings | null {
  if (typeof model !== "string" || model.trim() === "" || model.length > 256) return null;
  return {
    modelChoicesSource: "qualified",
    models: qualifiedModels.map((choice) => ({ ...choice, defaultEffort: null, efforts: [] })),
    collaborationModes: [],
    current: { model, effort: null, collaborationMode: null },
  };
}
