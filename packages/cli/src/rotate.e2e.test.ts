// End-to-end: spawn the real CLI (via tsx, non-TTY) to exercise --rc-rotate end to end — the
// dry-run preview, the TTY guard on a destructive execute, and a forced non-interactive rotate
// that actually replaces the identity.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function freshEnv() {
  const root = mkdtempSync(join(tmpdir(), "rc-rot-e2e-"));
  tempDirs.push(root);
  const xdg = join(root, "state");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_STATE_HOME: xdg };
  delete env.REMOTE_CLAW_SECRET_FILE;
  return { root, env, secretPath: join(xdg, "remote-claw", "secret") };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(tsxBin, [cliPath, ...args], { encoding: "utf8", env });
}

/** Create an identity and return its token + identity_id (via the dry-run --rc-quiet preview). */
function create(env: NodeJS.ProcessEnv): { token: string; id: string } {
  const c = runCli(["--rc-identity"], env);
  expect(c.status).toBe(0);
  const id = runCli(["--rc-rotate", "--rc-quiet"], env).stdout.trim(); // dry-run prints current id
  return { token: c.stdout.trim(), id };
}

describe("remote-claw --rc-rotate (e2e)", () => {
  it("bare --rc-rotate is a dry run: previews, changes nothing", () => {
    const { env, secretPath } = freshEnv();
    const { token, id } = create(env);
    const r = runCli(["--rc-rotate"], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(""); // default dry-run: nothing on stdout
    expect(r.stderr).toMatch(/DRY RUN/);
    expect(r.stderr).toContain(`--rc-confirm ${id}`);
    expect(readFileSync(secretPath, "utf8").trim()).toBe(token); // untouched
  });

  it("a non-TTY execute is refused without --rc-force-noninteractive", () => {
    const { env, secretPath } = freshEnv();
    const { token, id } = create(env);
    const r = runCli(["--rc-rotate", "--rc-confirm", id], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/interactive terminal/);
    expect(readFileSync(secretPath, "utf8").trim()).toBe(token); // unchanged
  });

  it("a forced non-interactive execute replaces the identity (stdout is the new token only)", () => {
    const { env, secretPath } = freshEnv();
    const { token: oldToken, id: oldId } = create(env);
    const r = runCli(["--rc-rotate", "--rc-confirm", oldId, "--rc-force-noninteractive"], env);
    expect(r.status).toBe(0);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TOKEN_RE);
    expect(lines[0]).not.toBe(oldToken);
    // the file now holds the new token; --rc-show-secret confirms it
    const newToken = readFileSync(secretPath, "utf8").trim();
    expect(newToken).toBe(lines[0]);
    expect(runCli(["--rc-show-secret"], env).stdout.trim()).toBe(newToken);
    // and the new id differs from the old
    expect(runCli(["--rc-rotate", "--rc-quiet"], env).stdout.trim()).not.toBe(oldId);
  });

  it("--rc-keep-old keeps the OLD secret as a live backup", () => {
    const { env, secretPath } = freshEnv();
    const { token: oldToken, id: oldId } = create(env);
    const r = runCli(
      ["--rc-rotate", "--rc-confirm", oldId, "--rc-keep-old", "--rc-force-noninteractive"],
      env,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/LIVE CREDENTIAL/);
    expect(readFileSync(`${secretPath}.old`, "utf8").trim()).toBe(oldToken); // backup is the old token
    expect(readFileSync(secretPath, "utf8").trim()).not.toBe(oldToken); // canonical is the new one
  });

  it("a wrong --rc-confirm exits 2 and changes nothing", () => {
    const { env, secretPath } = freshEnv();
    const { token } = create(env);
    const r = runCli(["--rc-rotate", "--rc-confirm", "deadbeefdeadbeefdeadbeefdeadbeef"], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/does not match/);
    expect(readFileSync(secretPath, "utf8").trim()).toBe(token);
  });

  it("rotate with no identity exits 1", () => {
    const { env } = freshEnv();
    const r = runCli(["--rc-rotate"], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/nothing to rotate/);
  });
});
