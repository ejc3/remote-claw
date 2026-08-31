// End-to-end: spawn the real `remote-claw` CLI (via tsx, non-TTY) and exercise `--rc-pass` — it
// issues a viewer pass (rcp1_) for the machine, distinct from the rc1_ master secret, and exits 1
// when no identity exists.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const PASS_RE = /^rcp1_[A-Za-z0-9_-]{171}[0-9A-HJKMNP-TV-Z]{4}$/;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function freshEnv() {
  const root = mkdtempSync(join(tmpdir(), "rc-pass-e2e-"));
  tempDirs.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
  };
  delete env.REMOTE_CLAW_SECRET_FILE;
  return { env };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(tsxBin, [cliPath, ...args], { encoding: "utf8", env });
}

describe("remote-claw --rc-pass (e2e)", () => {
  it("prints a viewer pass (rcp1_) on one stdout line after --rc-identity", () => {
    const { env } = freshEnv();
    expect(runCli(["--rc-identity"], env).status).toBe(0);
    const r = runCli(["--rc-pass"], env);
    expect(r.status).toBe(0);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toHaveLength(1); // stdout is ONLY the pass; the note is on stderr
    expect(lines[0]).toMatch(PASS_RE);
    expect(r.stderr).toMatch(/viewer pass/);
    expect(r.stderr).toMatch(/indefinite, machine-wide bearer credential/);
  });

  it("the pass differs from the master secret (rcp1_ vs rc1_)", () => {
    const { env } = freshEnv();
    const secret = runCli(["--rc-identity"], env).stdout.trim();
    const pass = runCli(["--rc-pass", "--rc-quiet"], env).stdout.trim();
    expect(secret.startsWith("rc1_")).toBe(true);
    expect(pass).toMatch(PASS_RE);
    expect(pass).not.toBe(secret);
  });

  it("--rc-pass with no identity exits 1 (run --rc-identity first)", () => {
    const { env } = freshEnv();
    const r = runCli(["--rc-pass"], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/--rc-identity/);
  });
});
