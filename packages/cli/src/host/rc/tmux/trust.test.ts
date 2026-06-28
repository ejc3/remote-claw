import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeJsonPath, ensureCwdTrusted } from "./trust.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  // realpath so the dir we pass equals what claude/ensureCwdTrusted keys by (macOS /tmp is a symlink).
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("claudeJsonPath", () => {
  it("uses <configDir>/.claude.json when configDir is set, else <home>/.claude.json", () => {
    expect(claudeJsonPath({ configDir: "/cfg", home: "/home/u" })).toBe("/cfg/.claude.json");
    expect(claudeJsonPath({ configDir: "  ", home: "/home/u" })).toBe("/home/u/.claude.json"); // blank = unset
  });
});

describe("ensureCwdTrusted", () => {
  it("creates an absent config with the cwd pre-trusted", () => {
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const r = ensureCwdTrusted(cwd, { home });
    expect(r.changed).toBe(true);
    expect(r.path).toBe(join(home, ".claude.json"));
    expect(r.key).toBe(cwd);
    const j = readJson(r.path);
    expect((j.projects as Record<string, unknown>)[cwd]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("DEEP-MERGES: preserves all other top-level keys, other projects, and sibling fields", () => {
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const file = join(home, ".claude.json");
    writeFileSync(
      file,
      JSON.stringify({
        oauthAccount: { emailAddress: "real@user" },
        numStartups: 42,
        projects: {
          "/other/project": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
          [cwd]: { allowedTools: ["Edit"], history: [{ x: 1 }] }, // present but NOT yet trusted
        },
      }),
    );
    const r = ensureCwdTrusted(cwd, { home });
    expect(r.changed).toBe(true);
    const j = readJson(file);
    // Untouched top-level keys + other project survive verbatim.
    expect(j.oauthAccount).toEqual({ emailAddress: "real@user" });
    expect(j.numStartups).toBe(42);
    expect((j.projects as Record<string, unknown>)["/other/project"]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ["Bash"],
    });
    // Our project's existing fields survive; the trust bit is added.
    expect((j.projects as Record<string, unknown>)[cwd]).toEqual({
      allowedTools: ["Edit"],
      history: [{ x: 1 }],
      hasTrustDialogAccepted: true,
    });
  });

  it("is idempotent: already-trusted → no write (file bytes unchanged)", () => {
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const file = join(home, ".claude.json");
    const original = JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } });
    writeFileSync(file, original);
    const before = statSync(file).mtimeMs;
    const r = ensureCwdTrusted(cwd, { home });
    expect(r.changed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(original); // byte-for-byte unchanged (no reformat)
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("flips an explicit false to true (preserving siblings)", () => {
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const file = join(home, ".claude.json");
    writeFileSync(
      file,
      JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: false, allowedTools: [] } } }),
    );
    expect(ensureCwdTrusted(cwd, { home }).changed).toBe(true);
    expect((readJson(file).projects as Record<string, unknown>)[cwd]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: [],
    });
  });

  it("honors configDir (writes <configDir>/.claude.json, not home)", () => {
    const home = tmp("rc-trust-home-");
    const configDir = tmp("rc-trust-cfg-");
    const cwd = tmp("rc-trust-cwd-");
    const r = ensureCwdTrusted(cwd, { home, configDir });
    expect(r.path).toBe(join(configDir, ".claude.json"));
    expect((readJson(r.path).projects as Record<string, unknown>)[cwd]).toEqual({
      hasTrustDialogAccepted: true,
    });
  });

  it("FAIL-SAFE: a present-but-malformed config is NOT clobbered (bailed)", () => {
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const file = join(home, ".claude.json");
    writeFileSync(file, "{ this is not json ");
    const r = ensureCwdTrusted(cwd, { home });
    expect(r.changed).toBe(false);
    expect(r.bailed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("{ this is not json "); // untouched
  });

  it("FAIL-SAFE: a present-but-UNREADABLE config is NOT clobbered (non-ENOENT read error → bailed)", () => {
    // A directory at the config path makes readFileSync throw EISDIR (a non-ENOENT read error, root-safe
    // unlike chmod). The data-loss bug treated any read error as "absent" → an unconditional clobber.
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const file = join(home, ".claude.json");
    mkdirSync(file);
    const r = ensureCwdTrusted(cwd, { home });
    expect(r.changed).toBe(false);
    expect(r.bailed).toBe(true);
    expect(statSync(file).isDirectory()).toBe(true); // still the original dir — NOT clobbered into a file
  });

  it("FAIL-SAFE: a valid-JSON but non-object top level is NOT clobbered (bailed)", () => {
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const file = join(home, ".claude.json");
    writeFileSync(file, "[1,2,3]"); // valid JSON, wrong shape
    const r = ensureCwdTrusted(cwd, { home });
    expect(r.changed).toBe(false);
    expect(r.bailed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("[1,2,3]"); // untouched
  });

  it("FAIL-SAFE: a present-but-non-object `projects` is NOT clobbered (bailed)", () => {
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const file = join(home, ".claude.json");
    const original = JSON.stringify({ projects: ["not", "a", "map"], numStartups: 7 });
    writeFileSync(file, original);
    const r = ensureCwdTrusted(cwd, { home });
    expect(r.changed).toBe(false);
    expect(r.bailed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original); // untouched — payload not coerced away
  });

  it("FAIL-SAFE: a present-but-non-object project ENTRY is NOT clobbered (bailed)", () => {
    const home = tmp("rc-trust-home-");
    const cwd = tmp("rc-trust-cwd-");
    const file = join(home, ".claude.json");
    const original = JSON.stringify({ projects: { [cwd]: "/some/string" } });
    writeFileSync(file, original);
    const r = ensureCwdTrusted(cwd, { home });
    expect(r.changed).toBe(false);
    expect(r.bailed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original); // untouched — not spread into indexed-char keys
  });

  it("keys by the cwd's REALPATH (claude resolves symlinks)", () => {
    const home = tmp("rc-trust-home-");
    const real = tmp("rc-trust-real-");
    const linkParent = tmp("rc-trust-link-");
    const link = join(linkParent, "alias");
    symlinkSync(real, link);
    const r = ensureCwdTrusted(link, { home });
    expect(r.key).toBe(real); // the realpath, not the symlink path
    const projects = readJson(r.path).projects as Record<string, unknown>;
    expect(projects[real]).toEqual({ hasTrustDialogAccepted: true });
    expect(projects[link]).toBeUndefined();
  });
});
