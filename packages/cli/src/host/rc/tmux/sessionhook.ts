// Claude Code SessionStart HOOK injection for the tmux driver (`--rc-session-hook`). We register a hook
// via an inline `--settings` JSON so the spawned claude reports its EXACT `transcript_path` + `session_id`
// (+ `source`) on session start AND on every rotation (`/clear`, `/compact`, resume) — verified live
// (the hook fires even in `-p`, payload carries the absolute, already-hashed transcript path). The hook
// command appends each payload as one NDJSON line to a SENTINEL file the driver tails: exact discovery
// (no scan, no long-cwd project-dir-hash problem) and clean rotation-follow (a new line = a rotation,
// unambiguous — no concurrent-sibling guesswork).
//
// The injected settings DEEP-MERGE with any `--settings` the user passed (a file path OR inline JSON):
// our SessionStart hook is APPENDED to their `hooks.SessionStart`, every other key preserved. The pure
// parts here are unit-tested; the driver owns the sentinel file + the tail.

import { readFile } from "node:fs/promises";

/** One SessionStart hook payload, normalized from the snake_case claude emits. */
export interface SessionHookEvent {
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  source?: string;
}

/** Single-quote a token for a POSIX shell command (the hook command runs via the user's shell). */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The settings fragment registering our SessionStart hook. The command appends the hook stdin payload
 *  (one JSON object) followed by a newline to `sentinelPath`, so the driver reads it as NDJSON across
 *  startup + rotations. */
export function sessionHookFragment(sentinelPath: string): {
  hooks: { SessionStart: Array<{ hooks: Array<{ type: "command"; command: string }> }> };
} {
  const p = shq(sentinelPath);
  const command = `cat >> ${p}; printf '\\n' >> ${p}`;
  return { hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } };
}

/** Parse a `--settings` value the user passed: inline JSON if it parses as an object, else a file path to
 *  read+parse (claude's own `<file-or-json>` rule). Returns `{}` when absent/unreadable/non-object — the
 *  merge still injects our hook. Never throws. */
export async function parseUserSettings(value: string | null): Promise<Record<string, unknown>> {
  if (value === null || value.trim() === "") return {};
  const asObj = (s: string): Record<string, unknown> | null => {
    try {
      const o: unknown = JSON.parse(s);
      return o !== null && typeof o === "object" && !Array.isArray(o)
        ? (o as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const inline = asObj(value);
  if (inline !== null) return inline;
  try {
    const fromFile = asObj(await readFile(value, "utf8"));
    if (fromFile !== null) return fromFile;
  } catch {
    /* not a readable file either — fall through to {} */
  }
  return {};
}

/** Deep-merge our SessionStart hook into the user's settings → a single `--settings` JSON string. Our
 *  hook is APPENDED to any existing `hooks.SessionStart` (the user's hooks run too), and every other
 *  settings key — including other hook events — is preserved untouched. */
export async function mergeSessionHookSettings(
  userSettings: string | null,
  sentinelPath: string,
): Promise<string> {
  const base = await parseUserSettings(userSettings);
  const ours = sessionHookFragment(sentinelPath);
  const baseHooks =
    base.hooks !== null && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? (base.hooks as Record<string, unknown>)
      : {};
  const baseStart = Array.isArray(baseHooks.SessionStart) ? baseHooks.SessionStart : [];
  const merged = {
    ...base,
    hooks: { ...baseHooks, SessionStart: [...baseStart, ...ours.hooks.SessionStart] },
  };
  return JSON.stringify(merged);
}

/** Extract the user's `--settings <val>` / `--settings=<val>` (before any `--` separator) from argv,
 *  returning the value (or null) and the args with that flag+value REMOVED — we re-add a single MERGED
 *  `--settings`. Only the first `--settings` is taken (claude uses one). Pure. */
export function extractSettingsArg(args: readonly string[]): {
  value: string | null;
  rest: string[];
} {
  const sep = args.indexOf("--");
  const optEnd = sep === -1 ? args.length : sep;
  const rest: string[] = [];
  let value: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (i < optEnd && value === null) {
      const eq = a.match(/^--settings=(.*)$/);
      if (eq) {
        value = eq[1] ?? "";
        continue;
      }
      if (a === "--settings") {
        const v = args[i + 1];
        if (v !== undefined) {
          value = v;
          i++; // consume the value token too
        }
        continue; // drop a dangling --settings with no value
      }
    }
    rest.push(a);
  }
  return { value, rest };
}

/** Parse the sentinel NDJSON; return the LAST event carrying both `session_id` and `transcript_path` (the
 *  current active session — later lines are rotations). Tolerant of partial/garbled/blank lines. Pure. */
export function parseSentinel(text: string): SessionHookEvent | null {
  let latest: SessionHookEvent | null = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let o: { session_id?: unknown; transcript_path?: unknown; cwd?: unknown; source?: unknown };
    try {
      o = JSON.parse(t);
    } catch {
      continue; // a torn line (mid-append) — skip; the next poll sees it complete
    }
    if (
      typeof o.session_id === "string" &&
      o.session_id !== "" &&
      typeof o.transcript_path === "string" &&
      o.transcript_path !== ""
    ) {
      latest = {
        sessionId: o.session_id,
        transcriptPath: o.transcript_path,
        ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}),
        ...(typeof o.source === "string" ? { source: o.source } : {}),
      };
    }
  }
  return latest;
}
