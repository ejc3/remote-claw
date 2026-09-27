import type { SessionSettings } from "../../../harness.js";

/** Session-only RC writes qualified against exact Claude 2.1.237. Not a discovered native catalog. */
export type ClaudeSessionModel = "claude-sonnet-4-6" | "claude-haiku-4-5-20251001";

export function isClaudeSessionModel(value: unknown): value is ClaudeSessionModel {
  return value === "claude-sonnet-4-6" || value === "claude-haiku-4-5-20251001";
}

export function claudeModelSettings(model: unknown): SessionSettings | null {
  if (typeof model !== "string" || model.trim() === "" || model.length > 256) return null;
  return {
    modelChoicesSource: "qualified",
    models: [
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", defaultEffort: null, efforts: [] },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", defaultEffort: null, efforts: [] },
    ],
    collaborationModes: [],
    current: { model, effort: null, collaborationMode: null },
  };
}
