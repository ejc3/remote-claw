// Pure transcript helpers — the view-independent logic behind the tool-call rows and diff viewer in
// page.tsx. Kept here (no React) so the parsing, sanitizing, and diff math are unit-testable.

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
  behavior: "allow" | "deny";
}

/** Parse a `permission_resolved` content frame — `{request_id, behavior}` — tolerating bad JSON. The
 *  host LOGS this when a permission is answered, so a reload / catch_up can render the request as
 *  resolved instead of re-prompting (#56). An unknown behavior defaults to "allow" (the relay only
 *  ever emits allow|deny; "" requestId means we couldn't fold it onto a request — caller drops it). */
export function parsePermissionResolved(text: string): PermissionResolution {
  try {
    const r = JSON.parse(text) as { request_id?: unknown; behavior?: unknown };
    return {
      requestId: typeof r.request_id === "string" ? r.request_id : "",
      behavior: r.behavior === "deny" ? "deny" : "allow",
    };
  } catch {
    return { requestId: "", behavior: "allow" };
  }
}
