import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitInfo, parseGitStatusV2 } from "./gitinfo.js";

function haveGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const GIT = haveGit();

// parseGitStatusV2 reads `git status --porcelain=v2 --branch`. Header lines carry branch/oid/ab; any
// non-`# ` line is a changed/untracked/unmerged entry → dirty. Pin the format handling here so gitInfo
// can stay a thin exec wrapper. (#49)
describe("parseGitStatusV2", () => {
  it("reads a clean branch with an upstream", () => {
    const out = [
      "# branch.oid 1234567890abcdef1234567890abcdef12345678",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
      "",
    ].join("\n");
    expect(parseGitStatusV2(out)).toEqual({
      branch: "main",
      sha: "12345678",
      dirty: false,
      ahead: 0,
      behind: 0,
    });
  });

  it("flags dirty on a tracked change AND on an untracked file, and reads ahead/behind", () => {
    const out = [
      "# branch.oid abcdef1234567890abcdef1234567890abcdef12",
      "# branch.head feature-x",
      "# branch.upstream origin/feature-x",
      "# branch.ab +3 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/foo.ts",
      "? scratch.txt",
      "",
    ].join("\n");
    expect(parseGitStatusV2(out)).toEqual({
      branch: "feature-x",
      sha: "abcdef12",
      dirty: true,
      ahead: 3,
      behind: 1,
    });
  });

  it("handles a detached HEAD and a missing upstream (no branch.ab)", () => {
    const out = ["# branch.oid deadbeefdeadbeefdeadbeef", "# branch.head (detached)", ""].join(
      "\n",
    );
    expect(parseGitStatusV2(out)).toEqual({
      branch: "(detached)",
      sha: "deadbeef",
      dirty: false,
      ahead: 0,
      behind: 0,
    });
  });

  it("reports an empty sha on an unborn branch (initial commit)", () => {
    const out = ["# branch.oid (initial)", "# branch.head main", ""].join("\n");
    expect(parseGitStatusV2(out)).toMatchObject({ branch: "main", sha: "", dirty: false });
  });

  it("treats an unmerged entry (u ...) as dirty", () => {
    const out = [
      "# branch.oid 0000111122223333",
      "# branch.head main",
      "u UU N... 100644 100644 100644 100644 x y z conflicted.ts",
      "",
    ].join("\n");
    expect(parseGitStatusV2(out).dirty).toBe(true);
  });
});

// Exercise the real exec wrapper against a throwaway repo so the actual `git status --porcelain=v2
// --branch` invocation (flags + cwd handling) is proven, not just the parser.
describe.skipIf(!GIT)("gitInfo (real git)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), "rc-git-"));
    dirs.push(d);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: d,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(d, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    return d;
  }

  it("reports a clean committed repo on branch main", async () => {
    const info = await gitInfo(repo());
    expect(info?.branch).toBe("main");
    expect(info?.dirty).toBe(false);
    expect(info?.sha).toMatch(/^[0-9a-f]{8}$/);
    expect(info).toMatchObject({ ahead: 0, behind: 0 });
  });

  it("reports dirty once the worktree has an uncommitted change", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "two\n"); // modify the committed file
    expect((await gitInfo(d))?.dirty).toBe(true);
  });

  it("returns null outside a git repo", async () => {
    const d = mkdtempSync(join(tmpdir(), "rc-nogit-"));
    dirs.push(d);
    expect(await gitInfo(d)).toBeNull();
  });
});
