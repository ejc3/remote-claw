// Pre-accept claude's per-folder TRUST dialog for the cwd the tmux driver spawns claude in.
//
// WHY (tmux driver, mirror on): permission mirroring (#148) drops `--dangerously-skip-permissions` so
// the PreToolUse hook is the sole tool gate. But that flag ALSO bypassed claude's startup "Do you trust
// the files in this folder?" gate — so on a FRESH/untrusted cwd the detached pane now blocks at that
// gate forever (it's a startup prompt, not a tool, so the PreToolUse hook doesn't cover it, and no one
// is at the pane to answer). Seeding the trust bit pre-spawn is exactly what claude records when a user
// clicks "trust", so the pane boots straight into a usable REPL.
//
// Mechanism (verified): claude stores trust in `<CLAUDE_CONFIG_DIR or ~>/.claude.json` under
// `projects["<abs realpath cwd>"].hasTrustDialogAccepted = true`. There is no CLI flag / env / settings
// key for it — an idempotent deep-merge into that file is the only lever.
//
// SAFETY: this writes the user's REAL config, so it is surgical — (1) idempotent: a no-op when the bit
// is already true; (2) preserving: deep-merges, never dropping any other top-level key, other project,
// or sibling field on this project; (3) fail-safe: if the file is present but we CAN'T safely touch it —
// unreadable (any read error other than ENOENT), unparseable, or an unexpected JSON shape (top-level or
// the `projects` map / entry not a plain object) — we BAIL rather than clobber it (returns bailed=true);
// (4) atomic: temp-write + rename so a crash mid-write can't truncate the config, and the temp is cleaned
// up if the write/rename throws.

import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TrustOptions {
  /** Override the home dir (tests). Default os.homedir(). */
  home?: string;
  /** Override CLAUDE_CONFIG_DIR (tests). Default process.env.CLAUDE_CONFIG_DIR. An empty value = unset. */
  configDir?: string;
}

export interface TrustResult {
  /** True if the file was written (the bit was absent/false); false if already trusted or we bailed. */
  changed: boolean;
  /** True when we DECLINED to write because the existing config is present-but-unsafe-to-touch (unreadable,
   *  unparseable, or an unexpected JSON shape). Distinct from the idempotent already-trusted no-op
   *  (changed=false, bailed undefined) so the caller can WARN that trust was NOT seeded (the pane may then
   *  hang on the startup trust gate) instead of staying silent. */
  bailed?: boolean;
  /** The .claude.json path we targeted. */
  path: string;
  /** The project key (abs realpath cwd) we trusted. */
  key: string;
}

/** Resolve the .claude.json path the same way claude does: `<CLAUDE_CONFIG_DIR>/.claude.json` when that
 *  env (or the `configDir` override) is set, else `<home>/.claude.json`. */
export function claudeJsonPath(opts: TrustOptions = {}): string {
  const configDir = (opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? "").trim();
  if (configDir) return join(configDir, ".claude.json");
  return join((opts.home ?? "").trim() || homedir(), ".claude.json");
}

/** Ensure claude's per-folder trust gate is pre-accepted for `cwd`, so the spawned (mirror-on) claude
 *  doesn't hang on the startup trust prompt. Idempotent, preserving, fail-safe, atomic (see file header).
 *  Returns what happened; never throws on a malformed/locked file path — callers log + continue. */
export function ensureCwdTrusted(cwd: string, opts: TrustOptions = {}): TrustResult {
  const file = claudeJsonPath(opts);
  // claude keys `projects` by the abs realpath of the cwd; match it (a no-op for non-symlinked paths).
  let key = cwd;
  try {
    key = realpathSync(cwd);
  } catch {
    // cwd not resolvable (shouldn't happen — it's the live process cwd) → fall back to the raw path.
  }

  // Read the existing config. ONLY ENOENT means genuinely absent (we'll create it). ANY OTHER read error
  // (EACCES/EISDIR/ELOOP/NFS hiccup) means the file is THERE but we can't read it — bailing beats
  // clobbering: the unconditional write below would otherwise replace the user's real config with a
  // one-key stub (data loss). Leave it untouched and report the bail (the user can trust interactively).
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return { changed: false, bailed: true, path: file, key }; // present-but-unreadable — don't clobber
    }
    raw = null; // genuinely absent → start from an empty config
  }
  let config: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { changed: false, bailed: true, path: file, key }; // unexpected shape — don't clobber
      }
      config = parsed as Record<string, unknown>;
    } catch {
      return { changed: false, bailed: true, path: file, key }; // malformed JSON — don't clobber
    }
  }

  // `projects` must be a plain object map. Absent ⇒ start fresh; present-but-not-an-object ⇒ BAIL rather
  // than coerce it to {} (which would silently drop the original payload on write — a clobber).
  const projectsRaw = config.projects;
  let projects: Record<string, Record<string, unknown>>;
  if (projectsRaw === undefined) {
    projects = {};
  } else if (
    typeof projectsRaw === "object" &&
    projectsRaw !== null &&
    !Array.isArray(projectsRaw)
  ) {
    projects = projectsRaw as Record<string, Record<string, unknown>>;
  } else {
    return { changed: false, bailed: true, path: file, key }; // `projects` present but not an object map
  }
  // The per-project entry must also be a plain object. Present-but-not-an-object ⇒ BAIL rather than spread
  // a string/array into indexed-char keys (`{...("/p")}` → `{0:"/",1:"p",…}`) — that would corrupt it.
  const project = projects[key];
  if (
    project !== undefined &&
    (typeof project !== "object" || project === null || Array.isArray(project))
  ) {
    return { changed: false, bailed: true, path: file, key };
  }
  if (project && project.hasTrustDialogAccepted === true) {
    return { changed: false, path: file, key }; // already trusted — idempotent no-op, no rewrite
  }

  // Deep-merge: set the trust bit, preserving this project's other fields, every other project, and all
  // other top-level keys.
  const merged: Record<string, unknown> = {
    ...config,
    projects: {
      ...projects,
      [key]: { ...(project ?? {}), hasTrustDialogAccepted: true },
    },
  };

  // Atomic write: a unique temp file in the SAME dir (rename is atomic only within a filesystem), then
  // rename over the target. mode 0o600 — the config can hold credentials; keep it owner-only. On any
  // write/rename failure, remove the temp so a 0o600 copy of the full config can't linger, then rethrow
  // (the driver's catch warns + continues).
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.rc-trust-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true }); // best-effort; force ⇒ no throw if the temp was never created
    throw e;
  }
  return { changed: true, path: file, key };
}
