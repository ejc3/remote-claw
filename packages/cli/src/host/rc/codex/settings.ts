import { parseSessionSettingsChange, type SessionSettings } from "../../../harness.js";

export type CodexSettingsUpdate =
  | { model: string }
  | { effort: string }
  | {
      collaborationMode: {
        mode: "plan" | "default";
        settings: { model: string; reasoning_effort: string; developer_instructions: null };
      };
    };

function record(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function text(raw: unknown, limit = 256): raw is string {
  return typeof raw === "string" && raw.trim() !== "" && raw.length <= limit;
}

/** Copy only picker-visible native model slugs and their advertised effort choices. */
export function parseCodexModels(raw: unknown): SessionSettings["models"] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) return null;
  const models: SessionSettings["models"][number][] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    const model = record(value);
    if (
      !model ||
      !text(model.model) ||
      !text(model.displayName) ||
      model.hidden !== false ||
      ids.has(model.model) ||
      !text(model.defaultReasoningEffort) ||
      !Array.isArray(model.supportedReasoningEfforts) ||
      model.supportedReasoningEfforts.length === 0 ||
      model.supportedReasoningEfforts.length > 12
    )
      return null;
    const efforts: { id: string; description: string }[] = [];
    const effortIds = new Set<string>();
    for (const value of model.supportedReasoningEfforts) {
      const effort = record(value);
      if (
        !effort ||
        !text(effort.reasoningEffort) ||
        effortIds.has(effort.reasoningEffort) ||
        typeof effort.description !== "string" ||
        effort.description.length > 512
      )
        return null;
      effortIds.add(effort.reasoningEffort);
      efforts.push({ id: effort.reasoningEffort, description: effort.description });
    }
    if (!effortIds.has(model.defaultReasoningEffort)) return null;
    ids.add(model.model);
    models.push({
      id: model.model,
      label: model.displayName,
      defaultEffort: model.defaultReasoningEffort,
      efforts,
    });
  }
  return models;
}

export function parseCodexModes(raw: unknown): SessionSettings["collaborationModes"] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return null;
  const modes: SessionSettings["collaborationModes"][number][] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    const mode = record(value);
    if (
      !mode ||
      !text(mode.name) ||
      (mode.mode !== "plan" && mode.mode !== "default") ||
      ids.has(mode.mode)
    )
      return null;
    ids.add(mode.mode);
    // Preset effort hints are deliberately not applied by our mode-only picker.
    modes.push({ id: mode.mode, label: mode.name });
  }
  return modes;
}

/** Unknown native values are display state, never extra catalog choices. */
export function parseCodexCurrentSettings(raw: unknown): SessionSettings["current"] | null {
  const settings = record(raw);
  const mode = record(settings?.collaborationMode);
  if (
    !settings ||
    !text(settings.model) ||
    (settings.effort != null && !text(settings.effort)) ||
    !mode ||
    !text(mode.mode)
  )
    return null;
  return { model: settings.model, effort: settings.effort ?? null, collaborationMode: mode.mode };
}

export function parseCodexResumeSettings(raw: unknown): SessionSettings["current"] | undefined {
  const response = record(raw);
  const thread = record(response?.thread);
  const model = response?.model ?? thread?.model;
  const effort =
    response && Object.hasOwn(response, "reasoningEffort")
      ? response.reasoningEffort
      : thread?.reasoningEffort;
  if (!text(model) || (effort != null && !text(effort))) return undefined;
  // Neither the resume envelope nor its Thread exposes current collaboration mode.
  return { model, effort: effort ?? null, collaborationMode: null };
}

/** Native API permits many policy fields. This client intentionally permits only these exact shapes. */
export function parseCodexSettingsUpdate(raw: unknown): CodexSettingsUpdate | null {
  const update = record(raw);
  if (!update || Object.keys(update).length !== 1) return null;
  if (text(update.model)) return { model: update.model };
  if (text(update.effort)) return { effort: update.effort };
  const mode = record(update.collaborationMode);
  const settings = record(mode?.settings);
  if (
    !mode ||
    Object.keys(mode).length !== 2 ||
    (mode.mode !== "plan" && mode.mode !== "default") ||
    !settings ||
    Object.keys(settings).length !== 3 ||
    !text(settings.model) ||
    !text(settings.reasoning_effort) ||
    settings.developer_instructions !== null
  )
    return null;
  return {
    collaborationMode: {
      mode: mode.mode,
      settings: {
        model: settings.model,
        reasoning_effort: settings.reasoning_effort,
        developer_instructions: null,
      },
    },
  };
}

export function codexSettingsUpdate(
  raw: unknown,
  settings: SessionSettings,
): CodexSettingsUpdate | null {
  const change = parseSessionSettingsChange(raw);
  if (!change) return null;
  if ("model" in change)
    return settings.models.some((model) => model.id === change.model)
      ? { model: change.model }
      : null;
  const current = settings.current;
  const model = settings.models.find((model) => model.id === current.model);
  if (!model) return null;
  if ("effort" in change)
    return model.efforts.some((effort) => effort.id === change.effort)
      ? { effort: change.effort }
      : null;
  if (
    (change.collaborationMode !== "plan" && change.collaborationMode !== "default") ||
    !settings.collaborationModes.some((mode) => mode.id === change.collaborationMode) ||
    current.effort === null ||
    !model.efforts.some((effort) => effort.id === current.effort)
  )
    return null;
  return {
    collaborationMode: {
      mode: change.collaborationMode,
      settings: {
        model: model.id,
        reasoning_effort: current.effort,
        developer_instructions: null,
      },
    },
  };
}
