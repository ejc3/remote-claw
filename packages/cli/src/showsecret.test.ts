import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, generateSecret, parseSecret, toHex } from "@remote-claw/clawsec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RcValue } from "./args.js";
import { runShowSecret } from "./showsecret.js";
import { ensureIdentity } from "./store.js";

const TOKEN_RE = /^rc1_[A-Za-z0-9_-]{43}[0-9A-HJKMNP-TV-Z]{4}$/;

function capture() {
  const parts: string[] = [];
  return { write: (s: string) => parts.push(s), text: () => parts.join("") };
}

let dir: string;
let secretPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rc-show-"));
  secretPath = join(dir, "secret");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rc(extra: Record<string, RcValue> = {}): Record<string, RcValue> {
  return { "rc-show-secret": true, "rc-file": secretPath, ...extra };
}

/** Seed a real identity at secretPath and return its token + identity_id hex. */
async function seed(): Promise<{ token: string; idHex: string }> {
  await ensureIdentity(secretPath, { now: () => new Date("2026-06-08T00:00:00Z") });
  const token = readFileSync(secretPath, "utf8").trim();
  return { token, idHex: toHex((await deriveIdentity(await parseSecret(token))).identityId) };
}

describe("runShowSecret (functional)", () => {
  it("non-TTY: prints the bare token to STDOUT, warning to STDERR (no leak in the warning)", async () => {
    const { token } = await seed();
    const out = capture();
    const e = capture();
    const code = await runShowSecret(rc(), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: false,
    });
    expect(code).toBe(0);
    expect(out.text()).toBe(`${token}\n`);
    expect(out.text().trim()).toMatch(TOKEN_RE);
    expect(e.text()).toMatch(/FULL credential/);
    expect(e.text()).not.toContain(token); // the warning never repeats the secret
    expect(e.text()).not.toContain(token.slice(4, 47)); // nor its base64url body
  });

  it("the revealed token round-trips to the same identity that's on disk", async () => {
    const { idHex } = await seed();
    const out = capture();
    await runShowSecret(rc(), [], { stdout: out.write, stderr: () => {}, isTty: false });
    const shown = out.text().trim();
    const got = toHex((await deriveIdentity(await parseSecret(shown))).identityId);
    expect(got).toBe(idHex);
  });

  it("TTY: warns and waits for Enter before revealing", async () => {
    const { token } = await seed();
    const out = capture();
    const e = capture();
    let waited = false;
    const code = await runShowSecret(rc(), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: true,
      awaitEnter: async () => {
        // the token must NOT be on stdout until after this resolves
        expect(out.text()).toBe("");
        waited = true;
      },
    });
    expect(code).toBe(0);
    expect(waited).toBe(true);
    expect(e.text()).toMatch(/Press Enter to reveal/);
    expect(out.text()).toBe(`${token}\n`);
  });

  it("TTY + --rc-yes: skips the Enter prompt and reveals immediately", async () => {
    const { token } = await seed();
    const out = capture();
    const e = capture();
    let waited = false;
    const code = await runShowSecret(rc({ "rc-yes": true }), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: true,
      awaitEnter: async () => {
        waited = true;
      },
    });
    expect(code).toBe(0);
    expect(waited).toBe(false); // --rc-yes ⇒ no pause
    expect(e.text()).not.toMatch(/Press Enter/);
    expect(out.text()).toBe(`${token}\n`);
  });

  it("arg-rule: a forwarded positional exits 2 and reveals nothing", async () => {
    await seed();
    const out = capture();
    const e = capture();
    const code = await runShowSecret(rc(), ["x"], {
      stdout: out.write,
      stderr: e.write,
      isTty: false,
    });
    expect(code).toBe(2);
    expect(out.text()).toBe("");
    expect(e.text()).toMatch(/does not launch claude/);
  });

  it("rejects an unsupported modifier (e.g. --rc-keep-old) with exit 2", async () => {
    await seed();
    const e = capture();
    const code = await runShowSecret(rc({ "rc-keep-old": true }), [], {
      stdout: () => {},
      stderr: e.write,
      isTty: false,
    });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not support --rc-keep-old/);
  });

  it("no identity yet: exits 1 with a 'run --rc-identity first' hint, no token", async () => {
    const out = capture();
    const e = capture();
    const code = await runShowSecret(rc(), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: false,
    });
    expect(code).toBe(1);
    expect(out.text()).toBe("");
    expect(e.text()).toMatch(/run `remote-claw --rc-identity` first/);
  });

  it("corrupt secret: exits 1 without printing a token", async () => {
    writeFileSync(secretPath, "not-a-real-token\n", { mode: 0o600 });
    const out = capture();
    const e = capture();
    const code = await runShowSecret(rc(), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: false,
    });
    expect(code).toBe(1);
    expect(out.text()).toBe("");
    expect(e.text()).toContain("remote-claw:");
  });

  it("--rc-file targets a specific secret file", async () => {
    const other = join(dir, "other-secret");
    const planted = await generateSecret();
    writeFileSync(other, `${planted.token}\n`, { mode: 0o600 });
    const out = capture();
    const code = await runShowSecret({ "rc-show-secret": true, "rc-file": other }, [], {
      stdout: out.write,
      stderr: () => {},
      isTty: false,
    });
    expect(code).toBe(0);
    expect(out.text()).toBe(`${planted.token}\n`);
  });

  it("rejects --rc-json (an --rc-identity flag) as unsupported here, exit 2", async () => {
    await seed();
    const e = capture();
    const code = await runShowSecret(rc({ "rc-json": true }), [], {
      stdout: () => {},
      stderr: e.write,
      isTty: false,
    });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not support --rc-json/);
  });

  it("with the default non-interactive stdin, reveals directly (no pause, no hang)", async () => {
    const { token } = await seed();
    const out = capture();
    // No isTty / awaitEnter injected → defaults to process.stdin.isTTY (false under vitest) → no
    // pause. This pins the fix: a non-interactive stdin must reveal, not block on Enter forever.
    const code = await runShowSecret(rc(), [], { stdout: out.write, stderr: () => {} });
    expect(code).toBe(0);
    expect(out.text()).toBe(`${token}\n`);
  });
});
