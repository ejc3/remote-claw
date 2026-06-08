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

  it("rejects an unsupported rc modifier (e.g. --rc-rotate) with exit 2 and writes no file", async () => {
    const e = capture();
    const code = await runIdentity(rc({ "rc-rotate": true }), [], {
      stdout: () => {},
      stderr: e.write,
    });
    expect(code).toBe(2);
    expect(e.text()).toMatch(/does not support --rc-rotate/);
    expect(existsSync(secretPath)).toBe(false); // rejected before any disk work
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
