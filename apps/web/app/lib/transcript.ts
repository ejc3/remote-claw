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
