// CAPTURE for the tmux driver: turn claude's local transcript JSONL into the canonical
// `UpstreamPayload`s the relay already understands. The decisive fact (verified against real
// transcripts, claude 2.1.63–2.1.177): the `message.content` blocks in
// `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl` are BYTE-IDENTICAL to what `mapUpstreamItems`
// destructures. So a top-level assistant/user/system line passes through with the sole rename
// `parentToolUseID → parent_tool_use_id`, and the relay/broker/viewer are unchanged.
//
// SUB-AGENTS (Agent/Task): claude writes a sub-agent's transcript to a SEPARATE file
// `<dir>/<id>/subagents/agent-<agentId>.jsonl` (+ a `.meta.json` sidecar) — NOT the main transcript
// (verified live, claude 2.1.177). The driver tails those files; each line reshapes through the SAME
// `transcriptToPayload`, and the driver overlays `parent_tool_use_id` = the spawning Agent's tool_use_id
// (read from the sidecar's `toolUseId` via `readAgentTaskId`) so the viewer NESTS sub-agent work under
// the Agent — like native Remote Control — instead of dropping it or flooding the main view.
//
// The pure parts (slug, reshape, line-splitting) are unit-tested with no fs; the tailer is a thin
// byte-offset reader over them. claude writes COMPLETE messages one-per-line (not a growing message), so
// per-line `pushUpstream` is correct — but a re-read after a watch/poll race can re-emit a line, so the
// caller dedups by `uuid` (review #2: re-pushing the same uuid does NOT dedup at the relay).

import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UpstreamPayload } from "../driver.js";

/** claude's project slug for a cwd: every `/` and `.` becomes `-` (verified against the real projects
 *  dir, e.g. `/home/ubuntu/remote-claw` → `-home-ubuntu-remote-claw`). Pure. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** The directory claude writes a session's transcript into: `~/.claude/projects/<slug(cwd)>`. */
export function projectDir(cwd: string, home: string = homedir()): string {
  return join(home, ".claude", "projects", projectSlug(cwd));
}

/** The transcript file for a known session id (claude names it `<sessionId>.jsonl`). When the tmux
 *  driver scrubs the parent session id, the spawned claude mints its OWN id, so we usually don't know
 *  it up front and use `findNewestTranscript` instead — but if a caller does know it, this is direct. */
export function transcriptPath(cwd: string, sessionId: string, home: string = homedir()): string {
  return join(projectDir(cwd, home), `${sessionId}.jsonl`);
}

/** A stable identity for a file: `dev:ino:birthtime`. dev:ino names the inode; birthtime distinguishes a
 *  RECREATED file at the same path even when the filesystem REUSES the inode number (ext4 does this), so
 *  a same-NAME rotation is detected and a recycled inode can't make a fresh file masquerade as an old
 *  one. Stable across appends (birthtime only changes on creation). birthtimeMs is 0 on filesystems that
 *  don't record it, degrading gracefully to dev:ino. Pure formatting. */
export function inodeKey(st: { dev: number; ino: number; birthtimeMs: number }): string {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}`; // birthtimeMs keeps ns precision on Linux
}

/**
 * Snapshot the inode identities of every `*.jsonl` ALREADY in the project dir, taken BEFORE we spawn.
 * `findNewestTranscript` excludes these so it can never attach to a concurrent PRE-EXISTING session's
 * file (codex review #2): a pre-existing file keeps its inode even as it's appended, so it stays
 * excluded; the file claude mints for THIS launch has a fresh inode not in the set. Returns an empty
 * set if the dir doesn't exist yet (no prior sessions). Never throws.
 */
export async function snapshotTranscriptInodes(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out; // dir not created yet — nothing pre-existing
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      out.add(inodeKey(await stat(join(dir, name))));
    } catch {
      // raced a delete — ignore (a file gone before we could stat it can't be ours)
    }
  }
  return out;
}

/**
 * Find the transcript claude created for THIS launch: among `*.jsonl` in the project dir, the newest
 * one whose inode is NOT in `exclude` (the pre-spawn snapshot) — i.e. a file that did not exist before
 * we launched. This is the PRIMARY discriminator (codex review #2): the shared project dir holds every
 * claude session's transcript, and a DIFFERENT pre-existing session is appended continuously (so its
 * mtime is always "now"); excluding pre-spawn inodes ignores it regardless of mtime/birthtime quirks.
 * Creation time (birthtime, fallback ctime) is a SECONDARY guard for files absent from `exclude` (e.g.
 * the snapshot raced a creation) and the tiebreaker when several qualify. If MORE THAN ONE fresh file
 * qualifies (a second claude started in the same cwd right after us — inherently ambiguous without the
 * child's session id), `onAmbiguity` is invoked with all candidates and we pick the newest. Returns
 * null while none exists yet (the file is created lazily on the first turn — poll again).
 */
export async function findNewestTranscript(
  dir: string,
  spawnedAtMs: number,
  opts: {
    exclude?: ReadonlySet<string>;
    slackMs?: number;
    onAmbiguity?: (paths: string[]) => void;
  } = {},
): Promise<string | null> {
  const exclude = opts.exclude ?? new Set<string>();
  // Small slack only tolerates clock granularity: OUR file is created strictly AFTER spawnedAt, so a
  // large window would needlessly admit a concurrent session's file created just before us (review
  // wf#10/#14). 250ms is ample for fs timestamp resolution.
  const slackMs = opts.slackMs ?? 250;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // dir not created yet (no turn has run) — caller retries
  }
  const candidates: { path: string; created: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    let created: number;
    let isExcludedInode: boolean;
    try {
      const st = await stat(path);
      isExcludedInode = exclude.has(inodeKey(st));
      // birthtimeMs is the file's creation time on Linux/macOS; it can be 0 on filesystems that don't
      // record it, in which case ctimeMs (inode change time, set at creation) is the best fallback.
      created = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
    } catch {
      continue; // raced a delete
    }
    const fresh = created + slackMs >= spawnedAtMs; // created at/after our spawn (within slack)
    // Exclude a file that was in the pre-spawn snapshot — UNLESS it's freshly created. ext4 (and most
    // filesystems) REUSE inode numbers, so a deleted pre-existing file's inode can land on OUR fresh
    // transcript; a fresh file is ours regardless of a recycled inode match (review wf#6).
    if (isExcludedInode && !fresh) continue; // genuinely pre-existing (old inode, old creation time)
    if (!fresh) continue; // created before our spawn, not pre-existing → a stranger from the race window
    candidates.push({ path, created });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.created - a.created); // newest first
  if (candidates.length > 1) opts.onAmbiguity?.(candidates.map((c) => c.path));
  return candidates[0]?.path ?? null;
}

/**
 * Claude writes a sub-agent (Agent/Task) transcript to a SEPARATE file under
 * `<dir>/<sessionId>/subagents/agent-<agentId>.jsonl` (+ a sibling `.meta.json`) — NOT the main
 * `<sessionId>.jsonl`. Given the MAIN transcript path, this returns its sibling `subagents/` dir. The
 * driver tails the `agent-*.jsonl` files here so sub-agent output is captured (a tailer following only
 * the main file misses it — verified live against claude 2.1.177). The dir doesn't exist until a
 * sub-agent spawns. Pure.
 */
export function subagentDir(transcriptPath: string): string {
  return join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
}

/** List the sub-agent transcript files (`agent-*.jsonl`, NOT the `.meta.json` sidecars) in `subDir`, as
 *  FULL paths. Returns [] when the dir doesn't exist yet (no sub-agent spawned). Never throws. */
export async function listSubagentFiles(subDir: string): Promise<string[]> {
  try {
    return (await readdir(subDir))
      .filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"))
      .map((n) => join(subDir, n));
  } catch {
    return [];
  }
}

/**
 * Read the spawning Agent/Task's `tool_use_id` for a sub-agent file from its sibling `.meta.json`
 * (`agent-<id>.jsonl` → `agent-<id>.meta.json`, e.g. `{"agentType","description","toolUseId"}`). This is
 * the DETERMINISTIC, spawn-time link that lets us nest the sub-agent's output under its Agent row in the
 * viewer (verified: the meta's `toolUseId` matches the Agent tool_use in the main transcript). Returns
 * null if the sidecar is absent/unreadable/lacks `toolUseId` (the caller then waits — don't surface a
 * sub-agent line we can't nest). Never throws.
 */
export async function readAgentTaskId(agentJsonlPath: string): Promise<string | null> {
  const metaPath = agentJsonlPath.replace(/\.jsonl$/, ".meta.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, "utf8"));
    const id = (parsed as { toolUseId?: unknown })?.toolUseId;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/**
 * The reshape (review-grounded): parse a transcript line and project it onto an `UpstreamPayload`.
 * Keeps only `type ∈ {assistant, user, system}` (the relay renders nothing else — real transcripts also
 * carry `progress`, `pr-link`, `bridge-session`, `ai-title`, `mode`, `permission-mode`, `attachment`,
 * `file-history-snapshot`, `queue-operation`, `agent-name`, `last-prompt`, …, all dropped here).
 * `message.content` blocks pass through UNCHANGED; the sole rename is `parentToolUseID →
 * parent_tool_use_id`. (Sub-agent files run through this SAME reshape; the driver overlays the nesting
 * `parent_tool_use_id` from the file's `.meta.json` — see readAgentTaskId.) Returns null for a dropped
 * type, a blank line, or unparseable JSON — so the tailer can ignore it.
 */
export function transcriptToPayload(line: string): UpstreamPayload | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null; // a partial/garbled line — drop (the tailer only feeds complete lines, but be safe)
  }
  const type = o.type;
  if (type !== "assistant" && type !== "user" && type !== "system") return null;

  const payload: UpstreamPayload = { type };
  // The content envelope (assistant/user) — passed through verbatim; mapUpstreamItems reads it as-is.
  if (o.message !== undefined) {
    payload.message = o.message as NonNullable<UpstreamPayload["message"]>;
  }
  // Stable id → stable worker/viewer payload + the caller's cross-reread dedup key.
  if (typeof o.uuid === "string") payload.uuid = o.uuid;
  // The ONLY rename: the local transcript uses camelCase `parentToolUseID`; the relay reads snake_case.
  if (typeof o.parentToolUseID === "string") payload.parent_tool_use_id = o.parentToolUseID;
  // system lifecycle fields the relay surfaces when subtype starts "task_" — pass through untouched.
  if (type === "system") {
    if (typeof o.subtype === "string") payload.subtype = o.subtype;
    if (typeof o.task_id === "string") payload.task_id = o.task_id;
    if (typeof o.description === "string") payload.description = o.description;
    if (typeof o.tool_use_id === "string") payload.tool_use_id = o.tool_use_id;
  }
  return payload;
}

/** Split a freshly-read chunk into complete lines + a trailing partial. Pure, so the partial-line
 *  buffering is unit-testable. `buffered` is the leftover from the previous read; the returned
 *  `rest` is buffered until the next read appends to it. */
export function splitLines(buffered: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffered + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? ""; // the last element is the trailing partial (no newline yet)
  return { lines: parts, rest };
}

/**
 * An append-only byte-offset reader over one transcript file. Each `poll()` reads from the last offset
 * to EOF, splits on `\n`, buffers the trailing partial line across polls, and returns the complete
 * lines read this tick. On a SHRINK (truncation / rotation) it resets to offset 0 and re-reads from the
 * top (the caller's uuid dedup absorbs any overlap). Decoding is incremental-safe: a multibyte char
 * split across a read boundary is held in the byte buffer (we slice on `\n` bytes, decode complete
 * lines only). The driver calls `poll()` on an fs.watch event and on a `pollMs` fallback.
 */
export class TranscriptTailer {
  #offset = 0;
  #partial = "";
  #decoder = new TextDecoder();
  #identity: string | null = null; // dev:ino of the file we're tailing (detects same-name rotation)

  constructor(private readonly path: string) {}

  /** Bytes consumed so far (for diagnostics/tests). */
  get offset(): number {
    return this.#offset;
  }

  /** Reset the read state to the top of a (new) file: offset, the partial-line buffer, AND a FRESH
   *  decoder (the streaming decoder may hold a half multibyte sequence from the old file). */
  #resetToTop(): void {
    this.#offset = 0;
    this.#partial = "";
    this.#decoder = new TextDecoder();
  }

  /** Read newly-appended complete lines since the last poll. Returns [] if the file is missing or
   *  nothing new was written. Never throws (an unreadable file just yields []).
   *
   *  OPEN-then-fstat (codex review #6): we open the handle FIRST and stat THAT handle, so identity, size
   *  and the bytes we read all refer to the SAME inode — a rotation between a separate stat() and open()
   *  could otherwise compute size/identity for the old file but read bytes from the new one (skip its
   *  prefix). */
  async poll(): Promise<string[]> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(this.path, "r");
    } catch {
      return []; // file not created yet / removed mid-rotation — caller retries on the next tick
    }
    try {
      let size: number;
      let identity: string;
      try {
        const st = await fh.stat();
        size = st.size;
        identity = inodeKey(st);
      } catch {
        return []; // couldn't stat the open handle — retry next tick
      }
      if (this.#identity !== null && identity !== this.#identity) {
        // Same NAME, different inode: claude replaced the file (rotation). The old offset is meaningless
        // against the new inode — restart from the top. The caller's uuid dedup absorbs any overlap.
        this.#resetToTop();
      }
      this.#identity = identity;
      if (size < this.#offset) {
        // The file shrank (truncate) — start over from the top so we don't read past EOF garbage.
        this.#resetToTop();
      }
      if (size === this.#offset) return []; // no new bytes
      const len = size - this.#offset;
      const buf = Buffer.allocUnsafe(len);
      let chunk: string;
      try {
        const { bytesRead } = await fh.read(buf, 0, len, this.#offset);
        this.#offset += bytesRead;
        // `stream: true` keeps a split multibyte sequence pending in the decoder across reads.
        chunk = this.#decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      } catch {
        return []; // a transient read error — retry next tick from the same offset
      }
      const { lines, rest } = splitLines(this.#partial, chunk);
      this.#partial = rest;
      return lines;
    } finally {
      await fh.close().catch(() => {});
    }
  }
}
