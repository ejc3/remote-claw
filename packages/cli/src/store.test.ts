import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, generateSecret, parseSecret, toHex } from "@remote-claw/clawsec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CreatedIdentity,
  ensureIdentity,
  loadSecret,
  resolveSecretPath,
  type StoreEnv,
  StoreError,
} from "./store.js";

// A fixed clock so created_at is deterministic.
const FIXED = new Date("2026-06-08T00:00:00.000Z");
const deps = { now: () => FIXED };

function fakeEnv(env: Record<string, string | undefined>, home = "/home/tester"): StoreEnv {
  return { env: env as NodeJS.ProcessEnv, homedir: () => home };
}

describe("resolveSecretPath (unit)", () => {
  it("prefers --rc-file over env and XDG, resolved to absolute", () => {
    const r = resolveSecretPath(
      { file: "/tmp/mine" },
      fakeEnv({ REMOTE_CLAW_SECRET_FILE: "/env/x", XDG_STATE_HOME: "/xdg" }),
    );
    expect(r).toEqual({ path: "/tmp/mine", source: "flag" });
  });

  it("prefers REMOTE_CLAW_SECRET_FILE over XDG when no flag", () => {
    const r = resolveSecretPath(
      {},
      fakeEnv({ REMOTE_CLAW_SECRET_FILE: "/env/x", XDG_STATE_HOME: "/xdg" }),
    );
    expect(r).toEqual({ path: "/env/x", source: "env" });
  });

  it("uses $XDG_STATE_HOME/remote-claw/secret when XDG set+absolute and no flag/env", () => {
    const r = resolveSecretPath({}, fakeEnv({ XDG_STATE_HOME: "/xdg" }));
    expect(r).toEqual({ path: "/xdg/remote-claw/secret", source: "xdg" });
  });

  it("falls back to ~/.local/state/remote-claw/secret when XDG unset", () => {
    const r = resolveSecretPath({}, fakeEnv({}, "/home/tester"));
    expect(r).toEqual({ path: "/home/tester/.local/state/remote-claw/secret", source: "home" });
  });

  it("treats empty XDG_STATE_HOME and empty REMOTE_CLAW_SECRET_FILE as unset", () => {
    const r = resolveSecretPath(
      {},
      fakeEnv({ XDG_STATE_HOME: "", REMOTE_CLAW_SECRET_FILE: "" }, "/home/t"),
    );
    expect(r.source).toBe("home");
    expect(r.path).toBe("/home/t/.local/state/remote-claw/secret");
  });

  it("treats an empty --rc-file as unset (falls through to env/xdg/home)", () => {
    const r = resolveSecretPath({ file: "" }, fakeEnv({ XDG_STATE_HOME: "/xdg" }));
    expect(r.source).toBe("xdg");
  });

  it("ignores a non-absolute $XDG_STATE_HOME (per XDG spec) and falls back to home", () => {
    const r = resolveSecretPath({}, fakeEnv({ XDG_STATE_HOME: "relative/dir" }, "/home/t"));
    expect(r).toEqual({ path: "/home/t/.local/state/remote-claw/secret", source: "home" });
  });

  it("expands a leading ~/ in --rc-file against homedir", () => {
    const r = resolveSecretPath({ file: "~/keys/s" }, fakeEnv({}, "/home/tester"));
    expect(r).toEqual({ path: "/home/tester/keys/s", source: "flag" });
  });

  it("expands a bare ~ in REMOTE_CLAW_SECRET_FILE", () => {
    const r = resolveSecretPath({}, fakeEnv({ REMOTE_CLAW_SECRET_FILE: "~" }, "/home/tester"));
    expect(r.path).toBe("/home/tester");
  });

  it("resolves a relative --rc-file to absolute against cwd", () => {
    const r = resolveSecretPath({ file: "rel/secret" }, fakeEnv({}));
    expect(r.path).toBe(join(process.cwd(), "rel/secret"));
    expect(r.path.startsWith("/")).toBe(true);
  });
});

describe("ensureIdentity + loadSecret (functional)", () => {
  let dir: string;
  let secretPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rc-store-"));
    secretPath = join(dir, "nested", "secret"); // nested → exercises mkdir of the parent
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a 0600 secret file and returns created:true with id+token+createdAt", async () => {
    const r = await ensureIdentity(secretPath, deps);
    expect(r.created).toBe(true);
    const c = r as CreatedIdentity;
    expect(c.token).toMatch(/^rc1_[A-Za-z0-9_-]{43}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(c.createdAt).toBe(FIXED.toISOString());
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  });

  it("writes the rc1_ TOKEN text + newline (not raw bytes) and round-trips to the same id", async () => {
    const r = (await ensureIdentity(secretPath, deps)) as CreatedIdentity;
    const onDisk = readFileSync(secretPath, "utf8");
    expect(onDisk).toBe(`${r.token}\n`);
    const secret = await parseSecret(onDisk.trim());
    const id = await deriveIdentity(secret);
    expect(toHex(id.identityId)).toBe(toHex(r.identityId));
  });

  it("creates the parent dir 0700 and a 0600 sidecar holding the ISO created_at", async () => {
    await ensureIdentity(secretPath, deps);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    const sidecar = `${secretPath}.created`;
    expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    expect(readFileSync(sidecar, "utf8").trim()).toBe(FIXED.toISOString());
  });

  it("is idempotent: a second run returns created:false and never rewrites the file", async () => {
    const first = (await ensureIdentity(secretPath, deps)) as CreatedIdentity;
    const bytesBefore = readFileSync(secretPath);
    const mtimeBefore = statSync(secretPath, { bigint: true }).mtimeNs;
    const sidecarMtimeBefore = statSync(`${secretPath}.created`, { bigint: true }).mtimeNs;

    const second = await ensureIdentity(secretPath, {
      now: () => new Date("2099-01-01T00:00:00Z"),
    });
    expect(second.created).toBe(false);
    expect("token" in second).toBe(false); // no token field on the idempotent path
    expect(toHex(second.identityId)).toBe(toHex(first.identityId));
    expect(readFileSync(secretPath)).toEqual(bytesBefore);
    expect(statSync(secretPath, { bigint: true }).mtimeNs).toBe(mtimeBefore);
    expect(statSync(`${secretPath}.created`, { bigint: true }).mtimeNs).toBe(sidecarMtimeBefore);
  });

  it("never clobbers a pre-existing secret (O_CREAT|O_EXCL): keeps the planted token", async () => {
    // Pre-plant a valid foreign secret, then ensureIdentity must defer to it, not overwrite.
    const planted = await generateSecret();
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(secretPath, `${planted.token}\n`, { mode: 0o600 });
    const r = await ensureIdentity(secretPath, deps);
    expect(r.created).toBe(false);
    expect(readFileSync(secretPath, "utf8")).toBe(`${planted.token}\n`);
    const id = await deriveIdentity(planted.secret);
    expect(toHex(r.identityId)).toBe(toHex(id.identityId));
  });

  it("rejects a corrupt secret with BAD_SECRET and leaves the file untouched", async () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(secretPath, "not-a-real-token\n", { mode: 0o600 });
    await expect(loadSecret(secretPath)).rejects.toMatchObject({ code: "BAD_SECRET" });
    expect(readFileSync(secretPath, "utf8")).toBe("not-a-real-token\n");
    // ensureIdentity over a corrupt existing file must surface the error, never regenerate.
    await expect(ensureIdentity(secretPath, deps)).rejects.toBeInstanceOf(StoreError);
    expect(readFileSync(secretPath, "utf8")).toBe("not-a-real-token\n");
  });

  it("rejects an empty secret file with BAD_SECRET", async () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(secretPath, "", { mode: 0o600 });
    await expect(loadSecret(secretPath)).rejects.toMatchObject({ code: "BAD_SECRET" });
  });

  it("rejects a group/other-readable secret with INSECURE_PERMS and a chmod hint", async () => {
    const first = (await ensureIdentity(secretPath, deps)) as CreatedIdentity;
    chmodSync(secretPath, 0o644);
    await expect(loadSecret(secretPath)).rejects.toMatchObject({ code: "INSECURE_PERMS" });
    await expect(loadSecret(secretPath)).rejects.toThrow(/chmod 600/);
    // no auto-chmod / no rewrite happened
    expect(statSync(secretPath).mode & 0o777).toBe(0o644);
    expect(readFileSync(secretPath, "utf8")).toBe(`${first.token}\n`);
  });

  it("refuses to read a secret through a symlink (SYMLINK_REFUSED)", async () => {
    const target = join(dir, "elsewhere");
    writeFileSync(target, `${(await generateSecret()).token}\n`, { mode: 0o600 });
    mkdirSync(join(dir, "nested"), { recursive: true });
    symlinkSync(target, secretPath);
    await expect(loadSecret(secretPath)).rejects.toMatchObject({ code: "SYMLINK_REFUSED" });
    await expect(ensureIdentity(secretPath, deps)).rejects.toMatchObject({
      code: "SYMLINK_REFUSED",
    });
  });

  it("maps a directory at the secret path to NOT_A_FILE", async () => {
    mkdirSync(secretPath, { recursive: true }); // the path itself is a dir
    await expect(loadSecret(secretPath)).rejects.toMatchObject({ code: "NOT_A_FILE" });
  });

  it("reports createdAt:null on the idempotent path when the sidecar is missing", async () => {
    await ensureIdentity(secretPath, deps);
    rmSync(`${secretPath}.created`); // drop the sidecar
    const loaded = await loadSecret(secretPath);
    expect(loaded.createdAt).toBeNull();
    const second = await ensureIdentity(secretPath, deps);
    expect(second.created).toBe(false);
    expect((second as { createdAt: string | null }).createdAt).toBeNull();
  });

  it("returns NOT_FOUND for a missing secret file", async () => {
    await expect(loadSecret(secretPath)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not block on (and rejects) a FIFO planted at the secret path", () => {
    if (process.platform === "win32") return; // no mkfifo
    mkdirSync(join(dir, "nested"), { recursive: true });
    execFileSync("mkfifo", [secretPath]);
    // O_NONBLOCK means the open returns instead of hanging forever on the writer-less FIFO;
    // the isFile() check then rejects it. A 5s vitest default would catch a hang.
    return expect(loadSecret(secretPath)).rejects.toMatchObject({ code: "NOT_A_FILE" });
  });

  it("ignores a symlinked sidecar instead of following it (created_at stays null)", async () => {
    await ensureIdentity(secretPath, deps);
    const target = join(dir, "secret-of-attacker");
    writeFileSync(target, "1999-01-01T00:00:00.000Z\n");
    rmSync(`${secretPath}.created`);
    symlinkSync(target, `${secretPath}.created`); // attacker-planted sidecar symlink
    const loaded = await loadSecret(secretPath);
    expect(loaded.createdAt).toBeNull(); // O_NOFOLLOW refuses it; the target is never read
  });

  it("ignores a non-ISO sidecar value (no escape-injection of created_at)", async () => {
    await ensureIdentity(secretPath, deps);
    writeFileSync(`${secretPath}.created`, "[31mnot-a-date[0m\n", { mode: 0o600 });
    const loaded = await loadSecret(secretPath);
    expect(loaded.createdAt).toBeNull();
  });

  it("creates successfully despite a leftover orphan temp file (random temp names)", async () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(`${secretPath}.deadbeef.tmp`, "junk"); // a crashed prior run's orphan
    const r = await ensureIdentity(secretPath, deps);
    expect(r.created).toBe(true);
    expect(existsSync(secretPath)).toBe(true);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  });

  it("maps a parent-path that is not a directory to a StoreError (not a raw throw)", async () => {
    const filePath = join(dir, "afile");
    writeFileSync(filePath, "x");
    // mkdir of `<afile>/sub` fails ENOTDIR; ensureIdentity must surface it as a StoreError.
    await expect(ensureIdentity(join(filePath, "sub", "secret"), deps)).rejects.toBeInstanceOf(
      StoreError,
    );
  });
});
