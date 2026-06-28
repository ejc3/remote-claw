// PreToolUse permission MIRRORING for the tmux driver (B2). A plain `claude` in a tmux pane normally
// runs with `--dangerously-skip-permissions` (every tool auto-approved, the viewer never sees a gate).
// To mirror permissions to the viewer faithfully — block each tool until the remote viewer answers,
// exactly like a real RC (mitm) session — we inject a `PreToolUse` hook via the SAME `--settings`
// deep-merge seam as the SessionStart hook (sessionhook.ts). claude honors a PreToolUse hook that
// returns `{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"|"deny"}}`
// (verified live), and the hook command's stdin carries session_id / tool_name / tool_input /
// tool_use_id / permission_mode.
//
// The hook command is a tiny, self-contained Node helper (Node is always present — claude runs on it)
// that the driver writes to the run's temp dir. On each tool the helper:
//   1. appends ONE request line (the tool + its tool_use_id) to a REQUESTS sentinel the driver tails,
//   2. BLOCKS, polling a per-tool DECISION file the driver writes when the viewer answers,
//   3. emits the decision as the PreToolUse hookSpecificOutput and exits.
// The driver tails the requests sentinel → raises a canonical `can_use_tool` gate (the relay + viewer
// already render that), and writes `<decisionDir>/<toolUseId>.json` when the viewer grants/denies.
//
// The PURE parts (the helper source, the hook fragment/command, the request parse, the decision file
// shape) are unit-tested here; permhook.test.ts also runs the helper as a real subprocess to prove the
// block→decide→emit loop end-to-end without needing a live claude. The driver owns the tail + the
// decision write + the live behavior.

/** One PreToolUse request, normalized from the snake_case claude emits, as the driver reads it off the
 *  requests sentinel. `toolUseId` keys the decision file. */
export interface PermRequest {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  sessionId: string;
  permissionMode: string;
}

/** A viewer decision the driver writes to `<decisionDir>/<toolUseId>.json`; the blocked helper reads it. */
export interface PermDecision {
  behavior: "allow" | "deny";
  reason?: string;
  /** AskUserQuestion (#42): the {questions, answers} object the helper re-emits as
   *  `hookSpecificOutput.updatedInput` so claude proceeds with the viewer's chosen answers instead of
   *  prompting in the pane. Present only on an AskUserQuestion ALLOW; ignored on deny. */
  updatedInput?: unknown;
}

/** Single-quote a token for a POSIX shell command (the hook command runs via the user's shell). */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The self-contained Node helper source. Written to disk by the driver and invoked as
 * `node <helperPath> <reqSentinel> <decisionDir> <pollMs>`. No imports from this package (it runs as a
 * standalone script under the child claude). Logic, kept deliberately small:
 *  - read the whole PreToolUse payload from stdin,
 *  - derive the tool_use_id (fall back to a per-process synthetic id used for BOTH the request line and
 *    the decision poll, so the two always match even if claude omitted it),
 *  - append one compact NDJSON request line in a single O_APPEND write (overlapping fires can't tear),
 *  - poll `<decisionDir>/<id>.json` until it appears, then emit the PreToolUse decision and exit 0.
 * It FAILS CLOSED: if it can't even record the request (an IO error that would otherwise hang the turn
 * forever) it emits `deny` with a reason rather than block — a denied tool is recoverable; a wrongly
 * allowed one is not. And it emits ONLY on a well-formed `{behavior:"allow"|"deny"}` decision: an empty
 * or torn read (the file observed mid-write) is ignored and it keeps polling, so a race can never flip a
 * viewer's deny into an allow. (The driver also writes the decision file atomically, tmp+rename.)
 */
export const PRE_TOOL_USE_HELPER_SOURCE = String.raw`#!/usr/bin/env node
// remote-claw tmux PreToolUse permission bridge (generated; see permhook.ts). Do not edit.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [, , reqSentinel, decisionDir, pollMsArg] = process.argv;
const pollMs = Math.max(20, Number.parseInt(pollMsArg ?? "", 10) || 100);

function emit(behavior, reason, updatedInput) {
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: behavior } };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  // AskUserQuestion (#42): on ALLOW, re-emit the viewer's {questions, answers} as updatedInput — claude
  // replaces the tool input with it and proceeds with those answers, skipping the in-pane picker. Never on
  // a deny (the tool won't run) and only for a non-null object (a scalar would corrupt the tool input).
  if (behavior === "allow" && updatedInput !== null && typeof updatedInput === "object") {
    out.hookSpecificOutput.updatedInput = updatedInput;
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function readStdin() {
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

const raw = await readStdin().catch(() => "");
let p = {};
try { p = JSON.parse(raw); } catch { p = {}; }

// A stable id for THIS invocation: claude's tool_use_id when present, else a synthetic one used for both
// the request line and the decision poll so the driver's write always matches our read. The synthetic id
// adds a random suffix on top of pid+time so two tools firing in the same millisecond (or after OS pid
// reuse) can't collide onto one leftover decision file and auto-resolve without a fresh viewer gate.
const id =
  typeof p.tool_use_id === "string" && p.tool_use_id
    ? p.tool_use_id
    : "notu-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

const req = {
  toolUseId: id,
  toolName: typeof p.tool_name === "string" ? p.tool_name : "tool",
  toolInput: p.tool_input ?? null,
  sessionId: typeof p.session_id === "string" ? p.session_id : "",
  permissionMode: typeof p.permission_mode === "string" ? p.permission_mode : "",
};

try {
  appendFileSync(reqSentinel, JSON.stringify(req) + "\n");
} catch (e) {
  // Can't even surface the request → don't hang the turn; deny with a reason.
  emit("deny", "remote-claw: could not record the permission request (" + String(e && e.message) + ")");
}

const decFile = join(decisionDir, id + ".json");
for (;;) {
  if (existsSync(decFile)) {
    let d = {};
    try { d = JSON.parse(readFileSync(decFile, "utf8")); } catch { d = {}; }
    // Emit ONLY on a WELL-FORMED decision. An empty/torn/garbled read — e.g. the file is observed between
    // the driver's create and write — leaves behavior !== allow|deny, so we KEEP POLLING rather than fall
    // OPEN to "allow": a denied tool must never run because a read raced the write. (The driver writes the
    // file ATOMICALLY via tmp+rename, so a present file is normally already complete; this guard is the
    // belt-and-suspenders that makes a partial read safe instead of fail-open.)
    if (d.behavior === "allow" || d.behavior === "deny") {
      // updatedInput is ONLY meaningful for AskUserQuestion (claude REPLACES the tool input with it, the
      // chosen {questions, answers}). Gate by the tool THIS hook fired for: a crafted answers payload on,
      // say, a Bash gate must never clobber that tool's real input. The driver also gates this upstream;
      // this is the authoritative last guard at the point we hand input to claude.
      const ui = req.toolName === "AskUserQuestion" ? d.updatedInput : undefined;
      emit(d.behavior, typeof d.reason === "string" ? d.reason : undefined, ui);
    }
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
`;

/** Build the PreToolUse hook command string: `<node> <helper> <reqSentinel> <decisionDir> <pollMs>`,
 *  each token single-quoted so spaces in a path are safe. `nodeBin` is the Node interpreter: the driver
 *  passes `process.execPath` (an ABSOLUTE path) rather than relying on a bare `node` being on the pane
 *  shell's PATH — a standalone/native claude install may run with no `node` on PATH, which would make the
 *  hook fail to spawn and silently bypass the gate. Defaults to `"node"` for callers/tests that don't care. */
export function preToolUseHookCommand(
  helperPath: string,
  reqSentinel: string,
  decisionDir: string,
  pollMs = 100,
  nodeBin = "node",
): string {
  return [
    shq(nodeBin),
    shq(helperPath),
    shq(reqSentinel),
    shq(decisionDir),
    shq(String(pollMs)),
  ].join(" ");
}

/** The settings fragment registering our PreToolUse hook (matcher `*` = every tool). Deep-merged into
 *  the user's `--settings` alongside the SessionStart hook (see mergeHooksIntoSettings). `nodeBin` threads
 *  through to the hook command (driver passes process.execPath). */
export function preToolUseHookFragment(
  helperPath: string,
  reqSentinel: string,
  decisionDir: string,
  pollMs = 100,
  nodeBin = "node",
): {
  hooks: {
    PreToolUse: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }>;
  };
} {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: preToolUseHookCommand(helperPath, reqSentinel, decisionDir, pollMs, nodeBin),
            },
          ],
        },
      ],
    },
  };
}

/** True if `id` is safe to use as a decision-FILE basename — no path separators or `..` traversal. The id
 *  is claude's tool_use_id (or our synthetic `notu-…`), echoed back through the viewer's permission frame;
 *  a crafted id with `/` or `..` could otherwise make the driver's decision write escape the decisions dir.
 *  Defense-in-depth (the relay only forwards ids it already gated), kept pure + unit-tested. */
export function isSafeToolUseId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(id) && !id.includes("..");
}

/** Parse one requests-sentinel NDJSON line into a PermRequest. Returns null for a blank/torn/garbled
 *  line or one missing a tool_use_id (the driver skips it; the next poll sees a complete line). Pure. */
export function parsePermRequest(line: string): PermRequest | null {
  const t = line.trim();
  if (t === "") return null;
  let o: {
    toolUseId?: unknown;
    toolName?: unknown;
    toolInput?: unknown;
    sessionId?: unknown;
    permissionMode?: unknown;
  };
  try {
    o = JSON.parse(t);
  } catch {
    return null; // torn mid-append — skip; the next poll sees it complete
  }
  if (typeof o.toolUseId !== "string" || o.toolUseId === "") return null;
  return {
    toolUseId: o.toolUseId,
    toolName: typeof o.toolName === "string" ? o.toolName : "tool",
    toolInput: o.toolInput ?? null,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : "",
    permissionMode: typeof o.permissionMode === "string" ? o.permissionMode : "",
  };
}

/** Serialize the decision file content the driver writes for `<toolUseId>.json`. `updatedInput` (the
 *  AskUserQuestion {questions, answers}, #42) is included only when provided AND the behavior is allow —
 *  a deny never carries it (the tool doesn't run). */
export function decisionFileContent(
  behavior: "allow" | "deny",
  reason?: string,
  updatedInput?: unknown,
): string {
  const d: PermDecision = { behavior };
  if (reason) d.reason = reason;
  if (behavior === "allow" && updatedInput !== undefined) d.updatedInput = updatedInput;
  return JSON.stringify(d);
}

/** Resolve whether to MIRROR permissions to the viewer (DEFAULT ON, B2). Off when the caller's opt-out
 *  `skipFlag` is set OR `env` is truthy ("1"/"true"/"yes"/"on"). Generic over the driver: the tmux path
 *  passes `--rc-tmux-skip-permissions` / `RC_TMUX_SKIP_PERMISSIONS`, the opencode path passes
 *  `--rc-oc-skip-permissions` / `RC_OC_SKIP_PERMISSIONS`. Pure + unit-tested so the precedence and the
 *  truthy set can't drift (mirrors resolveInjectSessionHook). */
export function resolveMirrorPermissions(o: {
  skipFlag: boolean;
  env: string | undefined;
}): boolean {
  if (o.skipFlag) return false;
  return !["1", "true", "yes", "on"].includes((o.env ?? "").trim().toLowerCase());
}
