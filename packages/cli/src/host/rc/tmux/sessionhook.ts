// Claude Code SessionStart HOOK support for the tmux driver. The driver ALWAYS registers one private hook
// through merged `--settings` and requires its first marker as native-readiness proof. The
// `--rc-session-hook` knob controls only whether capture keeps consuming that marker file for exact
// transcript discovery and rotations (`/clear`, `/compact`, resume). Each event reports the exact
// `transcript_path` + `session_id` (+ `source`) and appends one NDJSON line to the private sentinel.
//
// The injected settings DEEP-MERGE with any `--settings` the user passed (a file path OR inline JSON):
// our SessionStart hook is APPENDED to their `hooks.SessionStart`, every other key preserved. The pure
// parts here are unit-tested; the driver owns the sentinel file + the tail.

import { readFile } from "node:fs/promises";

/** One SessionStart hook payload, normalized from the snake_case claude emits. */
export interface SessionHookEvent {
  sessionId: string;
  transcriptPath: string;
  permissionMode?: string;
  cwd?: string;
  source?: string;
}

/** Single-quote a token for a POSIX shell command (the hook command runs via the user's shell). */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The settings fragment registering our SessionStart hook. The command writes the hook stdin payload
 *  (one compact JSON object claude emits) + a trailing newline to `sentinelPath` in ONE append:
 *  `printf '%s\n' "$(cat)" >> p` is a single O_APPEND write(2), so overlapping hook fires (concurrent
 *  rotations) can't interleave a half-written line — vs `cat >> p; printf '\n' >> p`, two separate
 *  appends another fire could split. The data goes through printf's `%s` ARGUMENT, so a `%` in the
 *  payload is never interpreted as a format. The driver reads the file as NDJSON across startup +
 *  rotations. */
export function sessionHookFragment(sentinelPath: string): {
  hooks: { SessionStart: Array<{ hooks: Array<{ type: "command"; command: string }> }> };
} {
  const p = shq(sentinelPath);
  const command = `printf '%s\\n' "$(cat)" >> ${p}`;
  return { hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } };
}

/** Keep remote pane input out of an active Claude turn and its native permission/question UI. The fixed
 * private helper makes
 * UserPromptSubmit take the same kernel flock as remote claim/paste/Enter, then closes the gate before
 * Claude begins the turn. If the local hook wins, remote input observes a busy gate before mutation; if
 * remote input wins, Claude's synchronous hook cannot let either submitted prompt begin until that one
 * pane mutation is complete. SessionEnd takes the same lock, closes the gate, and leaves a durable
 * terminal marker. Hook payloads are drained without being recorded or transported. */
export function turnGateHookFragment(
  gatePath: string,
  sessionEndedPath: string,
  helperPath: string,
  lockPath: string,
): HookFragment {
  // Claude 2.1.237 blocks UserPromptSubmit only for status 2. Normalize every helper failure (including
  // missing/killed helper statuses) to that exact contract instead of accidentally failing open.
  const prompt = `umask 077; ${[helperPath, "prompt", gatePath, lockPath]
    .map(shq)
    .join(" ")} || exit 2`;
  // SessionEnd itself cannot be blocked. If its serialized helper fails, require an independently-created
  // projection-retirement marker, then make a best-effort gate close. The private runtime directory is
  // already 0700; the explicit umask also keeps fallback-created files 0600.
  const endHelper = [helperPath, "end", gatePath, lockPath, sessionEndedPath].map(shq).join(" ");
  const end = `umask 077; ${endHelper} || { printf '%s' '' > ${shq(
    sessionEndedPath,
  )} || exit 2; printf '%s' '' > ${shq(gatePath)} || true; exit 0; }`;
  const command = (
    value: string,
  ): Array<{ hooks: Array<{ type: "command"; command: string }> }> => [
    { hooks: [{ type: "command", command: value }] },
  ];
  return {
    hooks: {
      UserPromptSubmit: command(prompt),
      SessionEnd: command(end),
    },
  };
}

/** Parse a `--settings` value the user passed: inline JSON object, else a file path to read+parse
 *  (claude's own `<file-or-json>` rule). Returns:
 *   - `{}` when ABSENT/blank (no user settings → we inject our hook fresh),
 *   - the parsed OBJECT when usable,
 *   - `null` when the user passed a NON-EMPTY value we can't parse into an object (missing file / invalid
 *     JSON / non-object). The tmux driver fails closed because its readiness hook is mandatory.
 *  Never throws. */
export async function parseUserSettings(
  value: string | null,
): Promise<Record<string, unknown> | null> {
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
    /* not a readable file either — fall through to the unparseable signal */
  }
  return null; // non-empty but unparseable → caller decides; tmux readiness fails closed
}

/** A settings fragment that registers one or more hooks (e.g. `{ hooks: { SessionStart: [...] } }` or
 *  `{ hooks: { PreToolUse: [...] } }`). Our hooks are APPENDED per event into the user's settings. */
export interface HookFragment {
  hooks: Record<string, unknown[]>;
}

/** Deep-merge our hook fragment(s) into the user's parsed settings: for each event in each fragment,
 *  APPEND our hook entries to the user's existing array for that event; preserve every other settings key
 *  and every other hook event untouched. A user `hooks` that is a NON-object, or a `hooks.<Event>` that is
 *  a NON-array, is REPLACED rather than merged — but claude's schema requires those to be an object / an
 *  array, so such input is invalid to claude anyway (we still emit valid, claude-acceptable settings).
 *  Pure. */
export function mergeHookFragments(
  base: Record<string, unknown>,
  fragments: readonly HookFragment[],
): Record<string, unknown> {
  const merged: Record<string, unknown> =
    base.hooks !== null && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? { ...(base.hooks as Record<string, unknown>) }
      : {};
  for (const frag of fragments) {
    for (const [event, entries] of Object.entries(frag.hooks)) {
      const existing = Array.isArray(merged[event]) ? (merged[event] as unknown[]) : [];
      merged[event] = [...existing, ...entries];
    }
  }
  return { ...base, hooks: merged };
}

/** Deep-merge our hook fragment(s) into the user's `--settings` → a single `--settings` JSON string, or
 *  `null` when the user passed a NON-EMPTY `--settings` we can't parse. */
export async function mergeHooksIntoSettings(
  userSettings: string | null,
  fragments: readonly HookFragment[],
): Promise<string | null> {
  const base = await parseUserSettings(userSettings);
  if (base === null) return null; // caller must not claim any hook-dependent capability
  return JSON.stringify(mergeHookFragments(base, fragments));
}

/** Deep-merge our SessionStart hook into the user's settings → a single `--settings` JSON string, or
 *  `null` when the user passed an unparseable `--settings`. Thin wrapper over
 *  mergeHooksIntoSettings for the common single-hook case. */
export async function mergeSessionHookSettings(
  userSettings: string | null,
  sentinelPath: string,
): Promise<string | null> {
  return mergeHooksIntoSettings(userSettings, [sessionHookFragment(sentinelPath)]);
}

/** Re-insert a single merged `--settings <value>` into argv BEFORE any `--` separator, so claude parses
 *  it as an OPTION. A token placed AFTER `--` is a literal positional (it would silently DROP our hook
 *  AND pollute the prompt with the JSON), so appending blindly is wrong whenever the user used `--`.
 *  `rest` is argv with the user's own `--settings` already stripped (see extractSettingsArg). Pure. */
export function insertSettingsArg(rest: readonly string[], value: string): string[] {
  const sep = rest.indexOf("--");
  const at = sep === -1 ? rest.length : sep;
  return [...rest.slice(0, at), "--settings", value, ...rest.slice(at)];
}

/** Resolve whether capture keeps using SessionStart markers for ongoing transcript discovery and
 * rotation-follow (DEFAULT ON). This does NOT control the mandatory private readiness hook. Precedence:
 * `--rc-no-session-hook` → off; `--rc-session-hook` → on; `RC_SESSION_HOOK` falsey → off; else on. */
export function resolveInjectSessionHook(o: {
  noFlag: boolean;
  yesFlag: boolean;
  env: string | undefined;
}): boolean {
  if (o.noFlag) return false;
  if (o.yesFlag) return true;
  return !["0", "false", "no", "off"].includes((o.env ?? "").trim().toLowerCase());
}

/** Extract the user's `--settings <val>` / `--settings=<val>` (before any `--` separator) from argv,
 *  returning the value (or null) and the args with ALL such flags+values REMOVED — we re-add a single
 *  MERGED `--settings`. When the user passes more than one, the LAST value wins (matches claude, which
 *  takes the last `--settings`); critically we must strip EVERY occurrence, else a later user
 *  `--settings` would override our merged one downstream and DROP our hook. Pure. */
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
    if (i < optEnd) {
      const eq = a.match(/^--settings=(.*)$/);
      if (eq) {
        value = eq[1] ?? ""; // keep overwriting → LAST --settings wins; strip this flag from rest
        continue;
      }
      if (a === "--settings") {
        const v = args[i + 1];
        if (v !== undefined && i + 1 < optEnd) {
          value = v; // value token is a real option value (not the `--` separator)
          i++; // consume it too
        }
        continue; // drop the flag (and a dangling/`--`-adjacent one with no usable value)
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
    let o: {
      session_id?: unknown;
      transcript_path?: unknown;
      permission_mode?: unknown;
      cwd?: unknown;
      source?: unknown;
    };
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
        ...(typeof o.permission_mode === "string" ? { permissionMode: o.permission_mode } : {}),
        ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}),
        ...(typeof o.source === "string" ? { source: o.source } : {}),
      };
    }
  }
  return latest;
}
