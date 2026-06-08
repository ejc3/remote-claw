import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, parseSecret, toHex } from "@remote-claw/clawsec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RcValue } from "./args.js";
import { runIdentity } from "./identity.js";
import { assertNoSecretLeak } from "./secretleak.js";
import type { StoreEnv } from "./store.js";

const TOKEN_RE = /^rc1_[A-Za-z0-9_-]{43}[0-9A-HJKMNP-TV-Z]{4}$/;
const FIXED = new Date("2026-06-08T00:00:00.000Z");

/** A captured output sink. */
function capture() {
  const parts: string[] = [];
  return { write: (s: string) => parts.push(s), text: () => parts.join("") };
}

let dir: string;
let secretPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rc-identity-"));
  secretPath = join(dir, "secret");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Build the rc map for --rc-identity with the file flag pointed at the test path. */
function rc(extra: Record<string, RcValue> = {}): Record<string, RcValue> {
  return { "rc-identity": true, "rc-file": secretPath, ...extra };
}

async function diskIdentity(): Promise<{ token: string; secret: Uint8Array }> {
  const token = readFileSync(secretPath, "utf8").trim();
  return { token, secret: await parseSecret(token) };
}

/** The 16-byte identity_id for a secret (to assert the summary prints the right one). */
async function idOf(secret: Uint8Array): Promise<Uint8Array> {
  return (await deriveIdentity(secret)).identityId;
}

describe("runIdentity (functional)", () => {
  it("CREATE default: token on its own STDOUT line, summary on STDERR, no leak in stderr", async () => {
    const out = capture();
    const e = capture();
    const code = await runIdentity(rc(), [], {
      stdout: out.write,
      stderr: e.write,
      now: () => FIXED,
    });
    expect(code).toBe(0);

    const lines = out
      .text()
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TOKEN_RE);

    const onDisk = await diskIdentity();
    expect(out.text()).toBe(`${onDisk.token}\n`); // printed token == file content
    expect(e.text()).toContain("identity_id:");
    expect(e.text()).toContain(`identity_id: ${toHex(await idOf(onDisk.secret))}`);
    expect(e.text()).toContain("created_at:");
    expect(e.text()).toContain(secretPath);
    assertNoSecretLeak(e.text(), onDisk); // the summary never repeats the secret
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  });

  it("IDEMPOTENT default: no token on STDOUT, status + show-secret hint on STDERR", async () => {
    await runIdentity(rc(), [], { stdout: () => {}, stderr: () => {}, now: () => FIXED });
    const onDisk = await diskIdentity();

    const out = capture();
    const e = capture();
    const code = await runIdentity(rc(), [], { stdout: out.write, stderr: e.write });
    expect(code).toBe(0);
    expect(out.text()).toBe(""); // never re-emits the secret
    expect(e.text()).toContain("already exists");
    expect(e.text()).toContain("--rc-show-secret");
    assertNoSecretLeak(out.text() + e.text(), onDisk);
  });

  it("--rc-json CREATE: one JSON line with public fields only, no secret in any encoding", async () => {
    const out = capture();
    const e = capture();
    const code = await runIdentity(rc({ "rc-json": true }), [], {
      stdout: out.write,
      stderr: e.write,
      now: () => FIXED,
    });
    expect(code).toBe(0);
    const onDisk = await diskIdentity();
    const parsed = JSON.parse(out.text());
    expect(Object.keys(parsed).sort()).toEqual(["created", "created_at", "identity_id", "path"]);
    expect(parsed).toMatchObject({
      created: true,
      created_at: FIXED.toISOString(),
      path: secretPath,
    });
    expect(parsed.identity_id).toMatch(/^[0-9a-f]{32}$/);
    expect(e.text()).toBe(""); // json mode keeps stderr quiet on success
    assertNoSecretLeak(out.text(), onDisk);
  });

  it("--rc-json IDEMPOTENT: created:false with created_at present, no secret", async () => {
    await runIdentity(rc(), [], { stdout: () => {}, stderr: () => {}, now: () => FIXED });
    const onDisk = await diskIdentity();
    const out = capture();
    const code = await runIdentity(rc({ "rc-json": true }), [], {
      stdout: out.write,
      stderr: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.created).toBe(false);
    expect(parsed.created_at).toBe(FIXED.toISOString());
    assertNoSecretLeak(out.text(), onDisk);
  });

  it("--rc-json takes precedence over --rc-quiet (JSON only, no bare token/id line)", async () => {
    const out = capture();
    const code = await runIdentity(rc({ "rc-json": true, "rc-quiet": true }), [], {
      stdout: out.write,
      stderr: () => {},
      now: () => FIXED,
    });
    expect(code).toBe(0);
    expect(() => JSON.parse(out.text())).not.toThrow();
    expect(out.text()).not.toContain("rc1_");
  });

  it("--rc-quiet CREATE: STDOUT is exactly the identity_id, token suppressed", async () => {
    const out = capture();
    const e = capture();
    const code = await runIdentity(rc({ "rc-quiet": true }), [], {
      stdout: out.write,
      stderr: e.write,
      now: () => FIXED,
    });
    expect(code).toBe(0);
    const onDisk = await diskIdentity();
    expect(out.text()).toMatch(/^[0-9a-f]{32}\n$/);
    expect(e.text()).toBe("");
    assertNoSecretLeak(out.text(), onDisk);
  });

  it("--rc-quiet IDEMPOTENT: identity_id only, no token", async () => {
    await runIdentity(rc(), [], { stdout: () => {}, stderr: () => {}, now: () => FIXED });
    const onDisk = await diskIdentity();
    const out = capture();
    const code = await runIdentity(rc({ "rc-quiet": true }), [], {
      stdout: out.write,
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/^[0-9a-f]{32}\n$/);
    assertNoSecretLeak(out.text(), onDisk);
  });

  it("arg-rule: a forwarded positional exits 2 and writes NO secret file", async () => {
    const e = capture();
    const code = await runIdentity(rc(), ["do-thing"], { stdout: () => {}, stderr: e.write });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not launch claude/);
    expect(existsSync(secretPath)).toBe(false); // misuse never touches disk
  });

  it("surfaces a corrupt existing secret as exit 1 without regenerating it", async () => {
    writeFileSync(secretPath, "not-a-real-token\n", { mode: 0o600 });
    const e = capture();
    const code = await runIdentity(rc(), [], { stdout: () => {}, stderr: e.write });
    expect(code).toBe(1);
    expect(e.text()).toContain("remote-claw:");
    expect(readFileSync(secretPath, "utf8")).toBe("not-a-real-token\n"); // untouched
  });

  it("default mode prints created_at: unknown when the sidecar is missing", async () => {
    await runIdentity(rc(), [], { stdout: () => {}, stderr: () => {}, now: () => FIXED });
    rmSync(`${secretPath}.created`);
    const e = capture();
    await runIdentity(rc(), [], { stdout: () => {}, stderr: e.write });
    expect(e.text()).toMatch(/created_at:\s+unknown/);
  });

  it("resolves the default path from an injected XDG env when no --rc-file is given", async () => {
    const env: StoreEnv = { env: { XDG_STATE_HOME: dir } as NodeJS.ProcessEnv, homedir: () => dir };
    const out = capture();
    const code = await runIdentity({ "rc-identity": true }, [], {
      stdout: out.write,
      stderr: () => {},
      now: () => FIXED,
      env,
    });
    expect(code).toBe(0);
    const xdgPath = join(dir, "remote-claw", "secret");
    expect(existsSync(xdgPath)).toBe(true);
    expect(statSync(xdgPath).mode & 0o777).toBe(0o600);
  });

  it("rejects an unsupported rc modifier (e.g. --rc-yes) with exit 2 and writes no file", async () => {
    const e = capture();
    const code = await runIdentity(rc({ "rc-yes": true }), [], {
      stdout: () => {},
      stderr: e.write,
    });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not support --rc-yes/);
    expect(existsSync(secretPath)).toBe(false); // rejected before any disk work
  });

  it("IDEMPOTENT default: also prints how to REPLACE (the confirm-guarded re-create)", async () => {
    await runIdentity(rc(), [], { stdout: () => {}, stderr: () => {}, now: () => FIXED });
    const { secret } = await diskIdentity();
    const idHex = toHex(await idOf(secret));
    const e = capture();
    await runIdentity(rc(), [], { stdout: () => {}, stderr: e.write });
    expect(e.text()).toMatch(/To REPLACE it/);
    expect(e.text()).toContain(`--rc-identity --rc-confirm ${idHex}`);
  });

  it("--rc-json on an error keeps STDOUT empty (parseable-or-empty), message to STDERR, exit 1", async () => {
    writeFileSync(secretPath, "not-a-real-token\n", { mode: 0o600 });
    const out = capture();
    const e = capture();
    const code = await runIdentity(rc({ "rc-json": true }), [], {
      stdout: out.write,
      stderr: e.write,
    });
    expect(code).toBe(1);
    expect(out.text()).toBe(""); // never partial/non-JSON on stdout
    expect(e.text()).toContain("remote-claw:");
  });

  it("--rc-json idempotent with a missing sidecar emits created_at:null (present, not omitted)", async () => {
    await runIdentity(rc(), [], { stdout: () => {}, stderr: () => {}, now: () => FIXED });
    rmSync(`${secretPath}.created`); // drop the sidecar
    const out = capture();
    const code = await runIdentity(rc({ "rc-json": true }), [], {
      stdout: out.write,
      stderr: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed.created).toBe(false);
    expect("created_at" in parsed).toBe(true);
    expect(parsed.created_at).toBeNull();
  });
});

describe("runIdentity — replace (--rc-confirm)", () => {
  const FIXED2 = new Date("2027-01-02T03:04:05.000Z");

  /** Seed an identity and return its token + id hex. */
  async function seed(): Promise<{ token: string; id: string }> {
    await runIdentity(rc(), [], { stdout: () => {}, stderr: () => {}, now: () => FIXED });
    const token = readFileSync(secretPath, "utf8").trim();
    const id = toHex((await deriveIdentity(await parseSecret(token))).identityId);
    return { token, id };
  }

  it("default success: NEW token on one STDOUT line, abandon summary on STDERR (no leak)", async () => {
    const { token: oldToken, id: oldId } = await seed();
    const out = capture();
    const e = capture();
    const code = await runIdentity(rc({ "rc-confirm": oldId }), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: true,
      now: () => FIXED2,
    });
    expect(code).toBe(0);
    const newToken = out.text().trim();
    expect(newToken).toMatch(TOKEN_RE);
    expect(newToken).not.toBe(oldToken);
    expect(out.text()).toBe(`${newToken}\n`); // token is the ONLY thing on stdout
    expect(e.text()).toMatch(/replaced identity/);
    expect(e.text()).toContain(`abandoned:   ${oldId}`);
    expect(e.text()).toMatch(/NOT revoked/);
    assertNoSecretLeak(e.text(), await diskIdentity()); // summary never repeats the new secret
    expect(toHex(await idOf((await diskIdentity()).secret))).not.toBe(oldId);
  });

  it("--rc-json success: created:true, replaced:true, public scalars only, no token", async () => {
    const { id: oldId } = await seed();
    const out = capture();
    const code = await runIdentity(rc({ "rc-confirm": oldId, "rc-json": true }), [], {
      stdout: out.write,
      stderr: () => {},
      isTty: true,
      now: () => FIXED2,
    });
    expect(code).toBe(0);
    const j = JSON.parse(out.text());
    expect(j).toMatchObject({
      created: true,
      replaced: true,
      old_identity_id: oldId,
      kept_old: false,
    });
    expect(j.identity_id).toMatch(/^[0-9a-f]{32}$/);
    expect(j.identity_id).not.toBe(oldId);
    assertNoSecretLeak(out.text(), await diskIdentity());
  });

  it("--rc-quiet success: just the new identity_id (not the token)", async () => {
    const { id: oldId } = await seed();
    const out = capture();
    await runIdentity(rc({ "rc-confirm": oldId, "rc-quiet": true }), [], {
      stdout: out.write,
      stderr: () => {},
      isTty: true,
    });
    expect(out.text()).toMatch(/^[0-9a-f]{32}\n$/);
    expect(out.text()).not.toMatch(TOKEN_RE);
    assertNoSecretLeak(out.text(), await diskIdentity());
  });

  it("--rc-keep-old: keeps the old secret as a live backup; loudly flagged", async () => {
    const { token: oldToken, id: oldId } = await seed();
    const out = capture();
    const e = capture();
    const code = await runIdentity(rc({ "rc-confirm": oldId, "rc-keep-old": true }), [], {
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
    const code = await runIdentity(rc({ "rc-confirm": "deadbeefdeadbeefdeadbeefdeadbeef" }), [], {
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
    const code = await runIdentity(rc({ "rc-confirm": `  ${id.toUpperCase()}\n` }), [], {
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
    const code = await runIdentity(rc({ "rc-confirm": id }), [], {
      stdout: () => {},
      stderr: e.write,
      isTty: false,
    });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/interactive terminal/);
    expect(readFileSync(secretPath, "utf8").trim()).toBe(token);
  });

  it("TTY override: --rc-force-noninteractive lets a non-TTY replace", async () => {
    const { id } = await seed();
    const out = capture();
    const code = await runIdentity(rc({ "rc-confirm": id, "rc-force-noninteractive": true }), [], {
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
    const code = await runIdentity(rc({ "rc-confirm": `wrong-${id}` }), [], {
      stdout: () => {},
      stderr: e.write,
      isTty: false, // would also fail the TTY guard, but mismatch wins
    });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not match/);
    expect(e.text()).not.toMatch(/interactive terminal/);
  });

  it("no identity present: --rc-confirm exits 1 with a create hint, writes nothing", async () => {
    const out = capture();
    const e = capture();
    const code = await runIdentity(rc({ "rc-confirm": "x" }), [], {
      stdout: out.write,
      stderr: e.write,
      isTty: true,
    });
    expect(code).toBe(1);
    expect(out.text()).toBe("");
    expect(e.text()).toMatch(/to replace.*drop --rc-confirm/);
    expect(existsSync(secretPath)).toBe(false);
  });

  it("corrupt secret: --rc-confirm exits 1 and changes nothing (refuses an unverifiable identity)", async () => {
    writeFileSync(secretPath, "not-a-real-token\n", { mode: 0o600 });
    const e = capture();
    const code = await runIdentity(rc({ "rc-confirm": "x" }), [], {
      stdout: () => {},
      stderr: e.write,
      isTty: true,
    });
    expect(code).toBe(1);
    expect(readFileSync(secretPath, "utf8")).toBe("not-a-real-token\n");
  });
});
