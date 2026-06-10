// A best-effort snapshot of the session's git state, folded onto the session_announce so the viewer
// can show a branch / dirty / ahead-behind chip (#49). It is metadata, not protocol: a session in a
// non-git dir (or on a machine without git) simply announces `git: null` and the chip is hidden.
//
// We use ONE `git status --porcelain=v2 --branch` call: its header lines carry the branch, HEAD oid,
// and ahead/behind vs upstream, and any non-header line means the worktree is dirty. Parsing is split
// out (pure) from the exec so the format handling is unit-testable without a real repo.

import { execFile } from "node:child_process";

export interface GitInfo {
  /** `branch.head` — the current branch, or "(detached)" with no branch checked out. */
  branch: string;
  /** Short HEAD oid (first 8 of `branch.oid`); "" on an unborn branch (no commits yet). */
  sha: string;
  /** Any tracked change, staged change, untracked file, or unmerged path present. */
  dirty: boolean;
  /** Commits ahead of the upstream (0 when no upstream is configured). */
  ahead: number;
  /** Commits behind the upstream (0 when no upstream is configured). */
  behind: number;
}

const HEAD = "# branch.head ";
const OID = "# branch.oid ";
const AB = "# branch.ab ";

/**
 * Parse `git status --porcelain=v2 --branch` output into a GitInfo. Pure and tolerant: missing header
 * lines fall back to defaults (a repo with no upstream omits `branch.ab`; an unborn branch reports an
 * `(initial)` oid). Any non-empty line that is NOT a `# ` header is a changed/untracked/unmerged entry,
 * so its mere presence means dirty — we never need to enumerate them.
 */
export function parseGitStatusV2(out: string): GitInfo {
  let branch = "(detached)";
  let sha = "";
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  for (const line of out.split("\n")) {
    if (line.startsWith(HEAD)) {
      branch = line.slice(HEAD.length).trim();
    } else if (line.startsWith(OID)) {
      const oid = line.slice(OID.length).trim();
      sha = oid === "(initial)" ? "" : oid.slice(0, 8);
    } else if (line.startsWith(AB)) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line !== "" && !line.startsWith("# ")) {
      dirty = true; // a tracked change, staged entry, untracked file, or unmerged path
    }
  }
  return { branch, sha, dirty, ahead, behind };
}

/**
 * Snapshot `cwd`'s git state, or null if it is not a git repo, git is unavailable, or the call times
 * out / overflows. Never throws and never blocks indefinitely (bounded by `timeout`); a failure just
 * yields null so the announce proceeds without a git chip.
 */
export function gitInfo(cwd: string, timeoutMs = 2000): Promise<GitInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: GitInfo | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const child = execFile(
        "git",
        ["status", "--porcelain=v2", "--branch"],
        { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 },
        (err, stdout) => done(err ? null : parseGitStatusV2(stdout)),
      );
      child.on("error", () => done(null)); // git not on PATH
    } catch {
      done(null); // spawn threw synchronously (e.g. cwd gone)
    }
  });
}
