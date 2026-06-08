// End-to-end: spawn the real CLI (via tsx, non-TTY) to create an identity and then re-reveal
// it with --rc-show-secret, asserting the revealed token matches and is the only thing on stdout.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "rc-show-e2e-"));
  tempDirs.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
  };
  // Don't inherit a dev/CI secret-file override — it would point the test at a real secret.
  delete env.REMOTE_CLAW_SECRET_FILE;
  return { root, env };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(tsxBin, [cliPath, ...args], { encoding: "utf8", env });
}

describe("remote-claw --rc-show-secret (e2e)", () => {
  it("re-reveals the created identity's token (non-TTY: token only on stdout, exit 0)", () => {
    const { env } = freshEnv();
    const create = runCli(["--rc-identity"], env);
    expect(create.status).toBe(0);
    const created = create.stdout.trim();
    expect(created).toMatch(TOKEN_RE);

    const show = runCli(["--rc-show-secret"], env);
    expect(show.status).toBe(0);
    expect(show.stdout.trim()).toBe(created); // same secret, re-revealed
    expect(show.stderr).toMatch(/FULL credential/); // warning on stderr
    // stdout is ONLY the token: `2>/dev/null` would yield the bare token + newline.
    const lines = show.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toEqual([created]);
  });

  it("exits 1 with a hint when there is no identity yet", () => {
    const { env } = freshEnv();
    const r = runCli(["--rc-show-secret"], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/--rc-identity/);
  });
});
