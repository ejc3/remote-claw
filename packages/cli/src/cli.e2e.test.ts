// End-to-end: spawn the real `remote-claw` CLI process (via tsx) against a stub `claude`
// binary, asserting it transparently forwards argv and propagates the child's exit code.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Write a fake `claude` to a tracked temp dir and return its path. */
function makeFakeClaude(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rc-fake-claude-"));
  tempDirs.push(dir);
  const path = join(dir, "fake-claude.mjs");
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A fake claude that echoes its argv as JSON and exits with `exitCode`. */
const echoClaude = (exitCode = 0) =>
  makeFakeClaude(
    `process.stdout.write(JSON.stringify(process.argv.slice(2)));process.exit(${exitCode});`,
  );

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync(tsxBin, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("remote-claw CLI (e2e)", () => {
  it("transparently forwards args to claude and propagates stdout + exit 0", () => {
    const r = runCli(["chat", "--model", "opus", "--", "--rc-identity"], {
      RC_CLAUDE_BIN: echoClaude(0),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["chat", "--model", "opus", "--", "--rc-identity"]);
    expect(r.stderr).not.toContain("ExperimentalWarning");
    expect(r.stderr).not.toContain("node:sqlite");
  });

  it("--help prints the rc help banner THEN claude's help (both layers)", () => {
    const r = runCli(["--help"], { RC_CLAUDE_BIN: echoClaude(0) });
    expect(r.status).toBe(0);
    // Our banner lands on stdout first; the fake claude then echoes its argv (incl. --help).
    expect(r.stdout).toMatch(/remote-claw/);
    expect(r.stdout).toMatch(/--rc-identity/);
    // The echoed argv is the LAST JSON array on stdout (robust even if the banner gains a `[`).
    const echoed = r.stdout.slice(r.stdout.lastIndexOf("["));
    expect(JSON.parse(echoed)).toEqual(["--help"]);
    // Banner precedes claude's output (the contract): "remote-claw" appears before the argv.
    expect(r.stdout.indexOf("remote-claw")).toBeLessThan(r.stdout.lastIndexOf("["));
  });

  it("propagates claude's non-zero exit code", () => {
    expect(runCli(["x"], { RC_CLAUDE_BIN: echoClaude(7) }).status).toBe(7);
  });

  it("runs bare claude when given no args", () => {
    const r = runCli([], { RC_CLAUDE_BIN: echoClaude(0) });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it("exits 2 with a message on an unknown --rc flag (never reaches claude)", () => {
    const r = runCli(["--rc-nope"], { RC_CLAUDE_BIN: echoClaude(0) });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/unknown flag --rc-nope/);
  });

  it("exits 127 with an explanation when the claude binary does not exist", () => {
    const r = runCli(["x"], { RC_CLAUDE_BIN: "/nonexistent/definitely/not/claude" });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/remote-claw: cannot run claude:/);
  });

  it("propagates a signal death as 128 + signo", () => {
    const sigterm = makeFakeClaude('process.kill(process.pid, "SIGTERM");');
    const r = runCli(["x"], { RC_CLAUDE_BIN: sigterm });
    expect(r.status).toBe(128 + constants.signals.SIGTERM);
  });
});
