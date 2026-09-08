// Pure transcript helpers — the view-independent logic behind the tool-call rows and diff viewer in
// page.tsx. Kept here (no React) so the parsing, sanitizing, and diff math are unit-testable.

import type { Message } from "./viewer.js";

export interface ToolInput {
  command?: string;
  description?: string;
  prompt?: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>; // MultiEdit
}

export interface ParsedTool {
  name: string;
  input: ToolInput;
  sub: boolean;
}

export function isRoutineActivityMessage(message: Message): boolean {
  if (message.kind === "tool_use" || message.kind === "task") return true;
  if (message.kind !== "tool_result") return false;
  const result = parseToolResult(message.text);
  // Errors remain first-class in the main transcript. An empty result already renders no row, so it
  // also acts as a boundary instead of creating a sheet with fewer than two visible events.
  return !result.isError && result.output !== "";
}

export interface ActivityGroup {
  kind: "activity_group";
  /** Stable while a live contiguous run grows: it is derived only from the run's first frame. */
  id: string;
  messages: readonly Message[];
}

export type TranscriptItem = { kind: "message"; message: Message } | ActivityGroup;

function activityCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * Project the raw transcript into render items without changing its chronology. Only maximal,
 * contiguous runs of routine, visible tool/task activity can roll up. Every other frame — including
 * errors and frames that render no visible row — is a hard boundary. A run becomes a rollup from its
 * first event so its identity, keyboard focus, and live announcements stay stable as more frames arrive.
 */
export function groupTranscriptActivity(messages: readonly Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: Message[] = [];

  const flush = () => {
    const first = run[0];
    if (!first) return;
    items.push({
      kind: "activity_group",
      id: JSON.stringify([first.msgId, first.seq]),
      messages: run,
    });
    run = [];
  };

  for (const message of messages) {
    if (isRoutineActivityMessage(message)) {
      run.push(message);
    } else {
      flush();
      items.push({ kind: "message", message });
    }
  }
  flush();
  return items;
}

/** Exact frame counts for a rollup. No provider state, completion, duration, or correlation is inferred. */
export function summarizeActivity(messages: readonly Message[]): string {
  let toolCalls = 0;
  let toolResults = 0;
  let taskEvents = 0;
  for (const message of messages) {
    if (message.kind === "tool_use") toolCalls++;
    else if (message.kind === "tool_result") toolResults++;
    else if (message.kind === "task") taskEvents++;
  }
  const parts: string[] = [];
  if (toolCalls > 0) parts.push(activityCount(toolCalls, "tool call"));
  if (toolResults > 0) parts.push(activityCount(toolResults, "tool result"));
  if (taskEvents > 0) parts.push(activityCount(taskEvents, "task event"));
  return parts.join(" · ");
}

const STR_FIELDS = [
  "command",
  "description",
  "prompt",
  "file_path",
  "old_string",
  "new_string",
  "content",
] as const;

// A tool's `input` is arbitrary model-authored JSON; keep only the fields we read, and only when
// they're actually strings. A wrong-typed field (e.g. a numeric file_path) then can never reach
// basename()/split() and throw mid-render — it's simply dropped. Returns a clean ToolInput.
export function sanitizeInput(raw: unknown): ToolInput {
  if (typeof raw !== "object" || raw === null) return {};
  const o = raw as Record<string, unknown>;
  const out: ToolInput = {};
  for (const k of STR_FIELDS) {
    const v = o[k];
    if (typeof v === "string") out[k] = v;
  }
  if (Array.isArray(o.edits)) {
    out.edits = o.edits.map((e) => {
      const eo = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
      const ed: { old_string?: string; new_string?: string } = {};
      if (typeof eo.old_string === "string") ed.old_string = eo.old_string;
      if (typeof eo.new_string === "string") ed.new_string = eo.new_string;
      return ed;
    });
  }
  return out;
}

/** Parse a `tool_use` content frame's text — `{name, input, sub}` — tolerating any malformed JSON. */
export function parseToolUse(text: string): ParsedTool {
  try {
    const t = JSON.parse(text) as { name?: unknown; input?: unknown; sub?: unknown };
    return {
      name: typeof t.name === "string" ? t.name : "tool",
      input: sanitizeInput(t.input),
      sub: t.sub === true,
    };
  } catch {
    return { name: "tool", input: {}, sub: false };
  }
}

// Reduce a tool's edit to the lines that actually changed. A plain Edit is (old_string→new_string);
// Write is ("" → content); MultiEdit is each entry of edits[]. Within each hunk we strip the common
// leading/trailing lines so unchanged context is neither shown nor counted as changed — otherwise a
// one-line change in a ten-line block would render (and tally) as +10 −10.
export function diffOf(input: ToolInput): { rem: string[]; add: string[] } {
  const drop = (s: string) => {
    const lines = s.split("\n");
    return lines.length === 1 && lines[0] === "" ? [] : lines;
  };
  const hunks =
    input.edits && input.edits.length > 0
      ? input.edits.map((e) => ({ old: e.old_string ?? "", neu: e.new_string ?? "" }))
      : [{ old: input.old_string ?? "", neu: input.new_string ?? input.content ?? "" }];
  const rem: string[] = [];
  const add: string[] = [];
  for (const h of hunks) {
    const a = drop(h.old);
    const b = drop(h.neu);
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let post = 0;
    while (
      post < a.length - pre &&
      post < b.length - pre &&
      a[a.length - 1 - post] === b[b.length - 1 - post]
    )
      post++;
    rem.push(...a.slice(pre, a.length - post));
    add.push(...b.slice(pre, b.length - post));
  }
  return { rem, add };
}

/** The +N/−N stat reflects the same changed lines the diff viewer shows (common context stripped). */
export function editStat(input: ToolInput): { add: number; del: number } {
  const { rem, add } = diffOf(input);
  return { add: add.length, del: rem.length };
}

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

/** A one-line hint for a tool — the Bash command, the file path, or the description (else ""). Used
 *  to give a permission prompt context about what the worker is asking to do. */
export function toolHint(input: ToolInput): string {
  return input.command ?? input.file_path ?? input.description ?? "";
}

/**
 * Whether a user message is a slash command claude runs (`/compact`, `/clear`, `/model opus`, …) rather
 * than a chat prompt — `/` + a word, then a space or end-of-string. The trailing `(?:\s|$)` distinguishes
 * a command from a path like `/home/ubuntu` (where a `/` follows the word, so it does NOT match). Such
 * messages are rendered as a distinct command chip instead of a chat pill (#41). `/compact` rides the
 * same `user` path as any prompt (captured via --rc-trace); the worker's reply is the compaction summary.
 */
export function isSlashCommand(text: string): boolean {
  return /^\/[a-zA-Z][\w-]*(?:\s|$)/.test(text.trim());
}

/** One choice in an AskUserQuestion question (#42). */
export interface QuestionOption {
  label: string;
  description: string;
}

/** One AskUserQuestion question — its header, prompt, choices, and whether multiple may be picked. */
export interface Question {
  /** Native questions answer by stable ID, never by their possibly repeated displayed prompt. */
  id?: string;
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowFreeText?: boolean;
}

/**
 * Parse an AskUserQuestion tool input into its questions (#42). The real shape (captured via
 * --rc-trace) is `{questions:[{question, header, options:[{label, description}], multiSelect}]}`.
 * Legacy inputs drop malformed entries. Explicit native forms are bounded and all-or-nothing, retain
 * stable IDs, and expose only the advertised free-text option. Returns [] for an unsupported form.
 */
export function parseQuestions(toolInput: unknown): Question[] {
  const raw = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  if (
    toolInput !== null &&
    typeof toolInput === "object" &&
    Object.hasOwn(toolInput, "nativeQuestions")
  ) {
    if ((toolInput as { nativeQuestions: unknown }).nativeQuestions !== true) return [];
    return parseNativeQuestions(raw);
  }
  return raw
    .map((q): Question => {
      const qq = (typeof q === "object" && q !== null ? q : {}) as Record<string, unknown>;
      const opts = Array.isArray(qq.options) ? qq.options : [];
      return {
        question: typeof qq.question === "string" ? qq.question : "",
        header: typeof qq.header === "string" ? qq.header : "",
        multiSelect: qq.multiSelect === true,
        options: opts
          .map((o): QuestionOption => {
            const oo = (typeof o === "object" && o !== null ? o : {}) as Record<string, unknown>;
            return {
              label: typeof oo.label === "string" ? oo.label : "",
              description: typeof oo.description === "string" ? oo.description : "",
            };
          })
          .filter((o) => o.label !== ""),
      };
    })
    .filter((q) => q.question !== "" && q.options.length > 0);
}

/** The native form is all-or-nothing: silently dropping a question would change the submitted answer. */
function parseNativeQuestions(raw: unknown[]): Question[] {
  if (raw.length < 1 || raw.length > 3) return [];
  const questions: Question[] = [];
  const ids = new Set<string>();
  const bounded = (value: unknown, max: number, nonblank = false): value is string =>
    typeof value === "string" && value.length <= max && (!nonblank || value.trim() !== "");
  for (const value of raw) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const q = value as Record<string, unknown>;
    if (
      !bounded(q.id, 256, true) ||
      ids.has(q.id) ||
      !bounded(q.header, 256) ||
      !bounded(q.question, 16_384, true) ||
      q.multiSelect !== false ||
      typeof q.allowFreeText !== "boolean" ||
      !Array.isArray(q.options) ||
      q.options.length < 1 ||
      q.options.length > 20
    )
      return [];
    const options: QuestionOption[] = [];
    const labels = new Set<string>();
    for (const option of q.options) {
      if (option === null || typeof option !== "object" || Array.isArray(option)) return [];
      const o = option as Record<string, unknown>;
      if (!bounded(o.label, 1024, true) || labels.has(o.label) || !bounded(o.description, 4096))
        return [];
      labels.add(o.label);
      options.push({ label: o.label, description: o.description });
    }
    ids.add(q.id);
    questions.push({
      id: q.id,
      header: q.header,
      question: q.question,
      options,
      multiSelect: false,
      allowFreeText: q.allowFreeText,
    });
  }
  return questions;
}

export function questionAnswerKey(question: Question): string {
  return question.id ?? question.question;
}

export interface ToolResult {
  toolUseId: string;
  isError: boolean;
  output: string;
  /** True when this is a sub-agent's tool output (the worker tagged it from `parent_tool_use_id`), so
   *  the UI can nest it under the Task — mirrors ParsedTool.sub for tool_use. */
  sub: boolean;
}

/** Parse a `tool_result` content frame — `{tool_use_id, is_error, output, sub}` — tolerating bad JSON. */
export function parseToolResult(text: string): ToolResult {
  try {
    const r = JSON.parse(text) as {
      tool_use_id?: unknown;
      is_error?: unknown;
      output?: unknown;
      sub?: unknown;
    };
    return {
      toolUseId: typeof r.tool_use_id === "string" ? r.tool_use_id : "",
      isError: r.is_error === true,
      output: typeof r.output === "string" ? r.output : "",
      sub: r.sub === true,
    };
  } catch {
    return { toolUseId: "", isError: false, output: "", sub: false };
  }
}

export interface TaskEvent {
  subtype: string;
  taskId: string;
  description: string;
  /** The spawning Task tool_use_id (relay carries it so the UI can correlate the lifecycle event to
   *  the Task row that started the sub-agent); "" when absent. */
  toolUseId: string;
}

/** Parse a `task` content frame — a sub-agent Task lifecycle event — tolerating bad JSON. */
export function parseTask(text: string): TaskEvent {
  try {
    const t = JSON.parse(text) as {
      subtype?: unknown;
      task_id?: unknown;
      description?: unknown;
      tool_use_id?: unknown;
    };
    return {
      subtype: typeof t.subtype === "string" ? t.subtype : "",
      taskId: typeof t.task_id === "string" ? t.task_id : "",
      description: typeof t.description === "string" ? t.description : "",
      toolUseId: typeof t.tool_use_id === "string" ? t.tool_use_id : "",
    };
  } catch {
    return { subtype: "", taskId: "", description: "", toolUseId: "" };
  }
}

export interface PermissionResolution {
  requestId: string;
  behavior: "allow" | "deny" | "pending" | "resolved";
  /** For an AskUserQuestion allow (#42), the answers the client sent, keyed by question text. Present
   *  only when the frame carried them — a plain permission allow/deny has none. Lets the resolved card
   *  render WHAT was answered (a faithful transcript of the choice), surviving replay from the selected
   *  host or durable-broker history path. */
  answers?: Record<string, string | string[]>;
}

/** Parse a `permission_resolved` replay frame — `{request_id, behavior, answers?}` — tolerating bad
 *  JSON. The relay emits this when a permission is answered. A non-durable host records/replays it via
 *  `catch_up`; a durable broker retains/replays the sealed frame directly. Either lets reload render the request
 *  as resolved instead of re-prompting (#56). Native pending means only that a choice was submitted;
 *  resolved means the native request ended, without claiming which peer or decision won. Unknown
 *  behavior retains the legacy "allow" fallback; an empty requestId is dropped by the caller. */
export function parsePermissionResolved(text: string): PermissionResolution {
  try {
    const r = JSON.parse(text) as { request_id?: unknown; behavior?: unknown; answers?: unknown };
    const res: PermissionResolution = {
      requestId: typeof r.request_id === "string" ? r.request_id : "",
      behavior:
        r.behavior === "deny" || r.behavior === "pending" || r.behavior === "resolved"
          ? r.behavior
          : "allow",
    };
    if (r.answers !== null && typeof r.answers === "object") {
      res.answers = r.answers as Record<string, string | string[]>;
    }
    return res;
  } catch {
    return { requestId: "", behavior: "allow" };
  }
}

/** Native terminal evidence wins even if an earlier submission frame arrives or replays later. */
export function foldPermissionResolutions(
  messages: ReadonlyArray<{ kind: string; text: string }>,
): Map<string, PermissionResolution["behavior"]> {
  const resolved = new Map<string, PermissionResolution["behavior"]>();
  for (const message of messages) {
    if (message.kind !== "permission_resolved") continue;
    const resolution = parsePermissionResolved(message.text);
    if (resolution.requestId === "") continue;
    const previous = resolved.get(resolution.requestId);
    if (resolution.behavior === "pending" && previous !== undefined && previous !== "pending")
      continue;
    resolved.set(resolution.requestId, resolution.behavior);
  }
  return resolved;
}

/** Parse an `accepted` ack body `{ client_msg_id, seq }` (#113). The host emits it for every inbound
 *  `user`/`attachment` send; the viewer uses it to reconcile its optimistic echo (match clientMsgId →
 *  re-key to `user-<seq>`). Returns null for a malformed/foreign ack the viewer should ignore. */
export function parseAccepted(text: string): { clientMsgId: string; seq: number } | null {
  try {
    const a = JSON.parse(text) as { client_msg_id?: unknown; seq?: unknown };
    if (typeof a.client_msg_id === "string" && typeof a.seq === "number")
      return { clientMsgId: a.client_msg_id, seq: a.seq };
  } catch {
    /* malformed → ignore */
  }
  return null;
}
