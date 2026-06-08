import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, parseSecret, toHex } from "@remote-claw/clawsec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RcValue } from "./args.js";
import { runRotate } from "./rotate.js";
import { assertNoSecretLeak } from "./secretleak.js";
import { ensureIdentity } from "./store.js";

const TOKEN_RE = /^rc1_[A-Za-z0-9_-]{43}[0-9A-HJKMNP-TV-Z]{4}$/;
const FIXED = new Date("2027-01-02T03:04:05.000Z");

function capture() {
  const parts: string[] = [];
  return { write: (s: string) => parts.push(s), text: () => parts.join("") };
}

let dir: string;
let secretPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rc-rotate-"));
  secretPath = join(dir, "secret");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rc(extra: Record<string, RcValue> = {}): Record<string, RcValue> {
  return { "rc-rotate": true, "rc-file": secretPath, ...extra };
}

/** Seed an identity and return its token + id hex. */
async function seed(): Promise<{ token: string; id: string }> {
  await ensureIdentity(secretPath, { now: () => new Date("2026-06-08T00:00:00Z") });
  const token = readFileSync(secretPath, "utf8").trim();
  return { token, id: toHex((await deriveIdentity(await parseSecret(token))).identityId) };
}

/** The current on-disk token + secret (for leak checks). */
async function diskId(): Promise<{ token: string; secret: Uint8Array }> {
  const token = readFileSync(secretPath, "utf8").trim();
  return { token, secret: await parseSecret(token) };
}

describe("runRotate — dry run (no --rc-confirm)", () => {
  it("default: previews to STDERR, changes nothing, names the execute command", async () => {
    const { token, id } = await seed();
    const out = capture();
    const e = capture();
    const code = await runRotate(rc(), [], { stdout: out.write, stderr: e.write });
    expect(code).toBe(0);
    expect(out.text()).toBe("");
    expect(e.text()).toMatch(/DRY RUN/);
    expect(e.text()).toContain(id);
    expect(e.text()).toContain(`--rc-confirm ${id}`);
    expect(readFileSync(secretPath, "utf8").trim()).toBe(token); // untouched
  });

  it("--rc-json: one JSON line, dry_run:true, no secret", async () => {
    const { id } = await seed();
    const onDisk = await diskId();
    const out = capture();
    const code = await runRotate(rc({ "rc-json": true }), [], {
      stdout: out.write,
      stderr: () => {},
    });
    expect(code).toBe(0);
    const j = JSON.parse(out.text());
    expect(j).toMatchObject({ rotated: false, dry_run: true, identity_id: id, would_destroy: id });
    assertNoSecretLeak(out.text(), onDisk);
  });

  it("--rc-quiet: just the current identity_id", async () => {
    const { id } = await seed();
    const out = capture();
    await runRotate(rc({ "rc-quiet": true }), [], { stdout: out.write, stderr: () => {} });
    expect(out.text()).toBe(`${id}\n`);
  });

  it("--rc-keep-old: preview flags the backup as a LIVE credential", async () => {
    await seed();
    const e = capture();
    await runRotate(rc({ "rc-keep-old": true }), [], { stdout: () => {}, stderr: e.write });
    expect(e.text()).toMatch(/LIVE CREDENTIAL/);
    expect(e.text()).toContain(`${secretPath}.old`);
  });

  it("no identity present: exits 1 with a 'nothing to rotate' hint", async () => {
    const out = capture();
    const e = capture();
    const code = await runRotate(rc(), [], { stdout: out.write, stderr: e.write });
    expect(code).toBe(1);
    expect(out.text()).toBe("");
    expect(e.text()).toMatch(/nothing to rotate.*--rc-identity/);
  });
});

describe("runRotate — execute (--rc-confirm)", () => {
  it("default success: NEW token on one STDOUT line, summary on STDERR (no token leak)", async () => {
    const { token: oldToken, id: oldId } = await seed();
    const out = capture();
    const e = capture();
    const code = await runRotate(rc({ "rc-confirm": oldId }), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: true,
      now: () => FIXED,
    });
    expect(code).toBe(0);
    const newToken = out.text().trim();
    expect(newToken).toMatch(TOKEN_RE);
    expect(newToken).not.toBe(oldToken);
    expect(out.text()).toBe(`${newToken}\n`); // token is the ONLY thing on stdout
    expect(e.text()).toMatch(/rotated identity/);
    expect(e.text()).toContain(`destroyed:   ${oldId}`);
    assertNoSecretLeak(e.text(), await diskId()); // the summary never repeats the new secret
    // disk now holds the new identity
    expect(toHex((await deriveIdentity((await diskId()).secret)).identityId)).not.toBe(oldId);
  });

  it("--rc-json success: public scalars only, no token", async () => {
    const { id: oldId } = await seed();
    const out = capture();
    const code = await runRotate(rc({ "rc-confirm": oldId, "rc-json": true }), [], {
      stdout: out.write,
      stderr: () => {},
      isTty: true,
      now: () => FIXED,
    });
    expect(code).toBe(0);
    const j = JSON.parse(out.text());
    expect(j).toMatchObject({ rotated: true, old_identity_id: oldId, kept_old: false });
    expect(j.identity_id).toMatch(/^[0-9a-f]{32}$/);
    expect(j.identity_id).not.toBe(oldId);
    assertNoSecretLeak(out.text(), await diskId());
  });

  it("--rc-quiet success: just the new identity_id (not the token)", async () => {
    const { id: oldId } = await seed();
    const out = capture();
    await runRotate(rc({ "rc-confirm": oldId, "rc-quiet": true }), [], {
      stdout: out.write,
      stderr: () => {},
      isTty: true,
    });
    expect(out.text()).toMatch(/^[0-9a-f]{32}\n$/);
    expect(out.text()).not.toMatch(TOKEN_RE);
    assertNoSecretLeak(out.text(), await diskId());
  });

  it("--rc-keep-old: keeps the old secret as a live backup; loudly flagged", async () => {
    const { token: oldToken, id: oldId } = await seed();
    const out = capture();
    const e = capture();
    const code = await runRotate(rc({ "rc-confirm": oldId, "rc-keep-old": true }), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: true,
    });
    expect(code).toBe(0);
    expect(e.text()).toMatch(/LIVE CREDENTIAL/);
    expect(readFileSync(`${secretPath}.old`, "utf8").trim()).toBe(oldToken);
  });

  it("confirm mismatch: exit 2, names only the expected id, never the supplied value, no change", async () => {
    const { token, id } = await seed();
    const out = capture();
    const e = capture();
    const code = await runRotate(rc({ "rc-confirm": "deadbeefdeadbeefdeadbeefdeadbeef" }), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: true,
    });
    expect(code).toBe(2);
    expect(out.text()).toBe("");
    expect(e.text()).toMatch(/does not match/);
    expect(e.text()).toContain(`expected: ${id}`);
    expect(e.text()).not.toContain("deadbeef"); // supplied value not echoed
    expect(readFileSync(secretPath, "utf8").trim()).toBe(token); // unchanged
  });

  it("confirm is case/whitespace tolerant (a paste with newline + uppercase still matches)", async () => {
    const { id } = await seed();
    const out = capture();
    const code = await runRotate(rc({ "rc-confirm": `  ${id.toUpperCase()}\n` }), [], {
      stdout: out.write,
      stderr: () => {},
      isTty: true,
    });
    expect(code).toBe(0);
    expect(out.text().trim()).toMatch(TOKEN_RE);
  });

  it("TTY guard: non-interactive without --rc-force-noninteractive exits 2, no change", async () => {
    const { token, id } = await seed();
    const e = capture();
    const code = await runRotate(rc({ "rc-confirm": id }), [], {
      stdout: () => {},
      stderr: e.write,
      isTty: false,
    });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/interactive terminal/);
    expect(readFileSync(secretPath, "utf8").trim()).toBe(token);
  });

  it("TTY override: --rc-force-noninteractive lets a non-TTY execute", async () => {
    const { id } = await seed();
    const out = capture();
    const code = await runRotate(rc({ "rc-confirm": id, "rc-force-noninteractive": true }), [], {
      stdout: out.write,
      stderr: () => {},
      isTty: false,
    });
    expect(code).toBe(0);
    expect(out.text().trim()).toMatch(TOKEN_RE);
  });

  it("confirm-mismatch is checked before the TTY guard", async () => {
    const { id } = await seed();
    const e = capture();
    const code = await runRotate(rc({ "rc-confirm": `wrong-${id}` }), [], {
      stdout: () => {},
      stderr: e.write,
      isTty: false, // would also fail the TTY guard, but mismatch wins
    });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not match/);
    expect(e.text()).not.toMatch(/interactive terminal/);
  });
});

describe("runRotate — guards & errors", () => {
  it("arg-rule: a forwarded positional exits 2", async () => {
    await seed();
    const e = capture();
    const code = await runRotate(rc(), ["x"], { stdout: () => {}, stderr: e.write });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not launch claude/);
  });

  it("rejects --rc-yes (not a rotate flag) with exit 2", async () => {
    await seed();
    const e = capture();
    const code = await runRotate(rc({ "rc-yes": true }), [], { stdout: () => {}, stderr: e.write });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not support --rc-yes/);
  });

  it("corrupt secret: exits 1 and changes nothing (refuses to rotate an unverifiable identity)", async () => {
    writeFileSync(secretPath, "not-a-real-token\n", { mode: 0o600 });
    const e = capture();
    const code = await runRotate(rc({ "rc-confirm": "x" }), [], {
      stdout: () => {},
      stderr: e.write,
      isTty: true,
    });
    expect(code).toBe(1);
    expect(readFileSync(secretPath, "utf8")).toBe("not-a-real-token\n");
  });

  it("--rc-json wins over --rc-quiet", async () => {
    await seed();
    const out = capture();
    await runRotate(rc({ "rc-json": true, "rc-quiet": true }), [], {
      stdout: out.write,
      stderr: () => {},
    });
    expect(() => JSON.parse(out.text())).not.toThrow();
  });
});
