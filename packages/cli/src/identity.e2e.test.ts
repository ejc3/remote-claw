// End-to-end: spawn the real `remote-claw` CLI (via tsx) and exercise `--rc-identity` against
// an isolated tmp HOME + XDG_STATE_HOME, asserting the real on-disk invariants (0600 mode,
// create-once idempotency, path routing) and that the identity path never launches claude.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const TOKEN_RE = /^rc1_[A-Za-z0-9_-]{43}[0-9A-HJKMNP-TV-Z]{4}$/;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** An isolated home for one test: HOME + XDG_STATE_HOME under a fresh temp dir. */
function freshEnv(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rc-id-e2e-"));
  tempDirs.push(root);
  const xdg = join(root, "state");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_STATE_HOME: xdg, ...extra };
  // Don't inherit a dev/CI secret-file override — it would point the test at a real secret.
  delete env.REMOTE_CLAW_SECRET_FILE;
  return { root, xdg, env, defaultPath: join(xdg, "remote-claw", "secret") };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(tsxBin, [cliPath, ...args], { encoding: "utf8", env });
}

describe("remote-claw --rc-identity (e2e)", () => {
  it("creates a 0600 secret at the XDG path, prints the token on one stdout line, exits 0", () => {
    const { env, defaultPath } = freshEnv();
    const r = runCli(["--rc-identity"], env);
    expect(r.status).toBe(0);
    // stdout is ONLY the token (the summary goes to stderr): `2>/dev/null` yields token + \n.
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TOKEN_RE);
    expect(r.stderr).toContain("created identity");
    expect(existsSync(defaultPath)).toBe(true);
    expect(statSync(defaultPath).mode & 0o777).toBe(0o600);
    // the parent dir is locked down too
    expect(statSync(join(defaultPath, "..")).mode & 0o777).toBe(0o700);
  });

  it("is idempotent: a second run prints no token, exits 0, leaves the file byte-identical", () => {
    const { env, defaultPath } = freshEnv();
    const first = runCli(["--rc-identity"], env);
    expect(first.status).toBe(0);
    const bytes = readFileSync(defaultPath);

    const second = runCli(["--rc-identity"], env);
    expect(second.status).toBe(0);
    expect(second.stdout).not.toMatch(/rc1_/);
    expect(second.stderr).toContain("already exists");
    expect(readFileSync(defaultPath)).toEqual(bytes);
  });

  it("--rc-file routes to a custom path and leaves the XDG default untouched", () => {
    const { env, defaultPath, root } = freshEnv();
    const custom = join(root, "custom-secret");
    const r = runCli(["--rc-identity", "--rc-file", custom], env);
    expect(r.status).toBe(0);
    expect(existsSync(custom)).toBe(true);
    expect(statSync(custom).mode & 0o777).toBe(0o600);
    expect(existsSync(defaultPath)).toBe(false);
  });

  it("REMOTE_CLAW_SECRET_FILE selects the path when no --rc-file is given", () => {
    const base = freshEnv();
    const target = join(base.root, "env-secret");
    const r = runCli(["--rc-identity"], { ...base.env, REMOTE_CLAW_SECRET_FILE: target });
    expect(r.status).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(base.defaultPath)).toBe(false);
  });

  it("falls back to ~/.local/state/remote-claw/secret when XDG_STATE_HOME is unset", () => {
    const { root, env } = freshEnv();
    const noXdg: NodeJS.ProcessEnv = { ...env };
    delete (noXdg as Record<string, string | undefined>).XDG_STATE_HOME;
    const r = runCli(["--rc-identity"], noXdg);
    expect(r.status).toBe(0);
    expect(existsSync(join(root, ".local", "state", "remote-claw", "secret"))).toBe(true);
  });

  it("--rc-json prints one parseable JSON object with no token substring", () => {
    const { env } = freshEnv();
    const r = runCli(["--rc-identity", "--rc-json"], env);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ created: true });
    expect(parsed.identity_id).toMatch(/^[0-9a-f]{32}$/);
    expect(r.stdout).not.toContain("rc1_");
  });

  it("never launches claude on the identity path (RC_CLAUDE_BIN sentinel stays unwritten)", () => {
    const { env, root } = freshEnv();
    const sentinel = join(root, "claude-ran");
    const fakeClaude = join(root, "fake-claude.mjs");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "x");\n`,
    );
    chmodSync(fakeClaude, 0o755);
    const r = runCli(["--rc-identity"], { ...env, RC_CLAUDE_BIN: `node ${fakeClaude}` });
    expect(r.status).toBe(0);
    expect(existsSync(sentinel)).toBe(false); // zero-claude, zero-network identity path
  });

  it("a forwarded positional exits 2 and writes no secret file", () => {
    const { env, defaultPath } = freshEnv();
    const r = runCli(["--rc-identity", "do-thing"], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/does not launch claude/);
    expect(existsSync(defaultPath)).toBe(false);
  });

  it("preserves a pre-existing secret file across a run (no clobber, no token)", () => {
    const { env, defaultPath } = freshEnv();
    // Seed via a first real create, capture the bytes, then re-run.
    const seed = runCli(["--rc-identity"], env);
    expect(seed.status).toBe(0);
    const before = readFileSync(defaultPath);
    const again = runCli(["--rc-identity"], env);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toMatch(/rc1_/);
    expect(readFileSync(defaultPath)).toEqual(before);
  });

  it("writes exactly 0600 even under a loose umask (explicit mode, not umask-derived)", () => {
    const { xdg, env } = freshEnv();
    const defaultPath = join(xdg, "remote-claw", "secret");
    // Force a permissive umask in the child; the file must still be 0600.
    const r = spawnSync("sh", ["-c", `umask 000; exec "${tsxBin}" "${cliPath}" --rc-identity`], {
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(0);
    expect(statSync(defaultPath).mode & 0o777).toBe(0o600);
  });
});

describe("remote-claw --rc-identity replace (--rc-confirm, e2e)", () => {
  /** Create an identity; return its token + id (the id via the idempotent --rc-quiet re-run). */
  function create(env: NodeJS.ProcessEnv): { token: string; id: string } {
    const c = runCli(["--rc-identity"], env);
    expect(c.status).toBe(0);
    const id = runCli(["--rc-identity", "--rc-quiet"], env).stdout.trim();
    return { token: c.stdout.trim(), id };
  }

  it("a forced non-interactive replace mints a new identity (stdout is the new token only)", () => {
    const { env, defaultPath } = freshEnv();
    const { token: oldToken, id: oldId } = create(env);
    const r = runCli(["--rc-identity", "--rc-confirm", oldId, "--rc-force-noninteractive"], env);
    expect(r.status).toBe(0);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TOKEN_RE);
    expect(lines[0]).not.toBe(oldToken);
    // the file now holds the new token; --rc-show-secret confirms it
    const newToken = readFileSync(defaultPath, "utf8").trim();
    expect(newToken).toBe(lines[0]);
    expect(runCli(["--rc-show-secret"], env).stdout.trim()).toBe(newToken);
    // and the new id differs from the old
    expect(runCli(["--rc-identity", "--rc-quiet"], env).stdout.trim()).not.toBe(oldId);
  });

  it("a non-TTY replace is refused without --rc-force-noninteractive", () => {
    const { env, defaultPath } = freshEnv();
    const { token, id } = create(env);
    const r = runCli(["--rc-identity", "--rc-confirm", id], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/interactive terminal/);
    expect(readFileSync(defaultPath, "utf8").trim()).toBe(token); // unchanged
  });

  it("--rc-keep-old keeps the OLD secret as a live backup", () => {
    const { env, defaultPath } = freshEnv();
    const { token: oldToken, id: oldId } = create(env);
    const r = runCli(
      ["--rc-identity", "--rc-confirm", oldId, "--rc-keep-old", "--rc-force-noninteractive"],
      env,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/LIVE CREDENTIAL/);
    expect(readFileSync(`${defaultPath}.old`, "utf8").trim()).toBe(oldToken); // backup is the old
    expect(readFileSync(defaultPath, "utf8").trim()).not.toBe(oldToken); // canonical is the new one
  });

  it("a wrong --rc-confirm exits 2 (mismatch, before the TTY guard) and changes nothing", () => {
    const { env, defaultPath } = freshEnv();
    const { token } = create(env);
    const r = runCli(["--rc-identity", "--rc-confirm", "deadbeefdeadbeefdeadbeefdeadbeef"], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/does not match/);
    expect(readFileSync(defaultPath, "utf8").trim()).toBe(token);
  });

  it("--rc-confirm with no identity exits 1 (nothing to replace)", () => {
    const { env } = freshEnv();
    const r = runCli(["--rc-identity", "--rc-confirm", "x"], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/to replace/);
  });
});
