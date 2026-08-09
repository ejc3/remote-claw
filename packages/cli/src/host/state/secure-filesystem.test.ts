import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_STATE_DATABASE_BASENAME } from "./path.js";
import {
  assertSecureHostStatePlatform,
  classifyHostStateFilesystemType,
  openSecureHostStateFilesystem,
  type SecureHostStateFilesystem,
} from "./secure-filesystem.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const hasSharedMemoryDirectory = existsSync("/dev/shm") && statSync("/dev/shm").isDirectory();
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);

const temporaryRoots: string[] = [];
const openGuardians: SecureHostStateFilesystem[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-secure-state-"));
  temporaryRoots.push(root);
  return root;
}

function statePaths(root: string): {
  stateHome: string;
  app: string;
  identities: string;
  identity: string;
  database: string;
} {
  const stateHome = join(root, "state");
  const app = join(stateHome, "remote-claw");
  const identities = join(app, "identities");
  const identity = join(identities, "rcmi_test");
  return {
    stateHome,
    app,
    identities,
    identity,
    database: join(identity, HOST_STATE_DATABASE_BASENAME),
  };
}

function createDirectories(
  paths: ReturnType<typeof statePaths>,
  modes: Partial<Record<"stateHome" | "app" | "identities" | "identity", number>> = {},
): void {
  for (const key of ["stateHome", "app", "identities", "identity"] as const) {
    mkdirSync(paths[key], { mode: modes[key] ?? 0o700 });
    chmodSync(paths[key], modes[key] ?? 0o700);
  }
}

function openGuarded(databasePath: string): SecureHostStateFilesystem {
  const guardian = openSecureHostStateFilesystem(databasePath);
  openGuardians.push(guardian);
  return guardian;
}

function closeGuarded(guardian: SecureHostStateFilesystem): void {
  guardian.close();
  const index = openGuardians.indexOf(guardian);
  if (index >= 0) openGuardians.splice(index, 1);
}

afterEach(() => {
  for (const guardian of openGuardians.splice(0).reverse()) {
    try {
      guardian.close();
    } catch {
      // A failed assertion test can deliberately poison a guarded path.
    }
  }
  for (const root of temporaryRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("host-state filesystem policy", () => {
  it("allows only the versioned native local-filesystem set", () => {
    expect(classifyHostStateFilesystemType(0xef53n)).toMatchObject({
      allowed: true,
      name: "ext",
      policyVersion: 1,
    });
    expect(classifyHostStateFilesystemType(0x58465342n).allowed).toBe(true);
    expect(classifyHostStateFilesystemType(0x9123683en).allowed).toBe(true);
    expect(classifyHostStateFilesystemType(0xf2f52010n).allowed).toBe(true);
    expect(classifyHostStateFilesystemType(0x2fc12fc1n).allowed).toBe(true);
  });

  it.each([
    [0x01021994n, "tmpfs"],
    [0x6969n, "nfs"],
    [0xff534d42n, "cifs"],
    [0x01021997n, "9p"],
    [0x65735546n, "fuse"],
    [0x794c7630n, "overlay"],
    [0x12345678n, "unknown-0x12345678"],
  ])("rejects filesystem type %s as %s", (type, name) => {
    expect(classifyHostStateFilesystemType(type)).toMatchObject({ allowed: false, name });
  });

  it("normalizes signed Linux magic values and rejects imprecise numbers", () => {
    expect(classifyHostStateFilesystemType(-11317950)).toMatchObject({
      allowed: false,
      name: "cifs",
    });
    expect(() => classifyHostStateFilesystemType(Number.MAX_VALUE)).toThrow("safe integer");
  });

  it("fails closed without the Linux and uid prerequisites", () => {
    expect(() => assertSecureHostStatePlatform("darwin", () => 501)).toThrow("only on Linux");
    expect(() => assertSecureHostStatePlatform("linux", () => -1)).toThrow("numeric process uid");
  });
});

describeLinux("secure host-state filesystem guardian", () => {
  it.runIf(hasSharedMemoryDirectory)("refuses a real tmpfs before creating database files", () => {
    const root = mkdtempSync(join("/dev/shm", "remote-claw-secure-state-"));
    temporaryRoots.push(root);
    const paths = statePaths(root);
    expect(() => openSecureHostStateFilesystem(paths.database)).toThrow(
      /filesystem tmpfs is not allowed/,
    );
    expect(() => lstatSync(paths.database)).toThrow();
  });

  it("creates, fsyncs, closes, and reopens the owner-only state tree", () => {
    const paths = statePaths(temporaryRoot());
    const guardian = openGuarded(paths.database);

    expect(guardian.databaseWasCreated).toBe(true);
    expect(guardian.databaseDescriptorPath).toMatch(/^\/proc\/self\/fd\/\d+$/);
    expect(guardian.filesystem.allowed).toBe(true);
    for (const directory of [paths.app, paths.identities, paths.identity]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(statSync(paths.stateHome).mode & 0o022).toBe(0);
    for (const suffix of ["", "-wal", "-shm"]) {
      const stat = lstatSync(`${paths.database}${suffix}`);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
    }
    guardian.assertStable();
    guardian.fsync();
    closeGuarded(guardian);

    const reopened = openGuarded(paths.database);
    expect(reopened.databaseWasCreated).toBe(false);
    reopened.assertStable();
  });

  it("permits a non-writable existing state home but requires exact private child modes", () => {
    const paths = statePaths(temporaryRoot());
    createDirectories(paths, { stateHome: 0o755 });
    const guardian = openGuarded(paths.database);
    guardian.assertStable();
  });

  it("pre-guards sidecar inodes before SQLite enters WAL mode", () => {
    const paths = statePaths(temporaryRoot());
    const guardian = openGuarded(paths.database);
    const before = Object.fromEntries(
      ["", "-wal", "-shm"].map((suffix) => [suffix, lstatSync(`${paths.database}${suffix}`).ino]),
    );
    const database = new DatabaseSync(guardian.databaseDescriptorPath);
    try {
      database.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE guarded(value TEXT); INSERT INTO guarded VALUES ('ok')",
      );
      guardian.assertStable();
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(lstatSync(`${paths.database}${suffix}`).ino).toBe(before[suffix]);
      }
    } finally {
      database.close();
    }
    closeGuarded(guardian);

    const reopened = openGuarded(paths.database);
    const verify = new DatabaseSync(reopened.databaseDescriptorPath);
    try {
      expect(verify.prepare("SELECT value FROM guarded").get()).toEqual({ value: "ok" });
    } finally {
      verify.close();
    }
  });

  it("rejects a permissive state home or child directory", () => {
    const permissiveHome = statePaths(temporaryRoot());
    createDirectories(permissiveHome, { stateHome: 0o777 });
    expect(() => openSecureHostStateFilesystem(permissiveHome.database)).toThrow(
      "must not be group- or world-writable",
    );

    const permissiveChild = statePaths(temporaryRoot());
    createDirectories(permissiveChild, { app: 0o750 });
    expect(() => openSecureHostStateFilesystem(permissiveChild.database)).toThrow(
      "directory mode must be 700",
    );
  });

  it("detects a state-home chmod after open", () => {
    const paths = statePaths(temporaryRoot());
    const guardian = openGuarded(paths.database);
    chmodSync(paths.stateHome, 0o777);
    expect(() => guardian.assertStable()).toThrow("forbidden permission bits");
  });

  it("rejects symlinked directories and state files", () => {
    const directoryPaths = statePaths(temporaryRoot());
    mkdirSync(directoryPaths.stateHome, { mode: 0o700 });
    const target = join(temporaryRoot(), "redirect");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, directoryPaths.app);
    expect(() => openSecureHostStateFilesystem(directoryPaths.database)).toThrow(
      "cannot securely open host state directory",
    );

    const filePaths = statePaths(temporaryRoot());
    createDirectories(filePaths);
    const targetFile = join(temporaryRoot(), "target.db");
    writeFileSync(targetFile, "", { mode: 0o600 });
    symlinkSync(targetFile, filePaths.database);
    expect(() => openSecureHostStateFilesystem(filePaths.database)).toThrow(
      "cannot securely open host-state-v1.db",
    );
  });

  it("rejects unsafe file mode and hard links", () => {
    const modePaths = statePaths(temporaryRoot());
    createDirectories(modePaths);
    writeFileSync(modePaths.database, "", { mode: 0o644 });
    expect(() => openSecureHostStateFilesystem(modePaths.database)).toThrow(
      "owner-only regular files with one link",
    );

    const linkPaths = statePaths(temporaryRoot());
    createDirectories(linkPaths);
    writeFileSync(linkPaths.database, "", { mode: 0o600 });
    linkSync(linkPaths.database, join(linkPaths.identity, "second-link"));
    expect(() => openSecureHostStateFilesystem(linkPaths.database)).toThrow(
      "owner-only regular files with one link",
    );
  });

  it("rejects rollback journals, including dangling symlinks", () => {
    const journalPaths = statePaths(temporaryRoot());
    createDirectories(journalPaths);
    writeFileSync(`${journalPaths.database}-journal`, "", { mode: 0o600 });
    expect(() => openSecureHostStateFilesystem(journalPaths.database)).toThrow(
      "SQLite rollback journal is forbidden",
    );

    const symlinkPaths = statePaths(temporaryRoot());
    createDirectories(symlinkPaths);
    symlinkSync("missing-target", `${symlinkPaths.database}-journal`);
    expect(() => openSecureHostStateFilesystem(symlinkPaths.database)).toThrow(
      "SQLite rollback journal is forbidden",
    );

    const lateJournalPaths = statePaths(temporaryRoot());
    const guardian = openGuarded(lateJournalPaths.database);
    writeFileSync(`${lateJournalPaths.database}-journal`, "", { mode: 0o600 });
    expect(() => guardian.assertStable()).toThrow("SQLite rollback journal is forbidden");
  });

  it("refuses orphan WAL/SHM state instead of adopting it into a new database", () => {
    for (const suffix of ["-wal", "-shm"]) {
      const paths = statePaths(temporaryRoot());
      createDirectories(paths);
      writeFileSync(`${paths.database}${suffix}`, "", { mode: 0o600 });
      expect(() => openSecureHostStateFilesystem(paths.database)).toThrow(
        /sidecars cannot exist without a host state database/,
      );
      expect(() => lstatSync(paths.database)).toThrow();
    }
  });

  it("detects path replacement, mode changes, and added hard links after open", () => {
    const replacePaths = statePaths(temporaryRoot());
    const replaced = openGuarded(replacePaths.database);
    renameSync(replacePaths.database, `${replacePaths.database}.moved`);
    writeFileSync(replacePaths.database, "", { mode: 0o600 });
    expect(() => replaced.assertStable()).toThrow("path identity changed");

    const modePaths = statePaths(temporaryRoot());
    const remoded = openGuarded(modePaths.database);
    chmodSync(`${modePaths.database}-wal`, 0o640);
    expect(() => remoded.assertStable()).toThrow("file mode must be 600");

    const linkPaths = statePaths(temporaryRoot());
    const linked = openGuarded(linkPaths.database);
    linkSync(`${linkPaths.database}-shm`, join(linkPaths.identity, "shm-link"));
    expect(() => linked.assertStable()).toThrow("exactly one link");
  });

  it("rejects malformed paths before creating state", () => {
    const root = temporaryRoot();
    expect(() => openSecureHostStateFilesystem(join(root, "wrong.db"))).toThrow(
      "must be named host-state-v1.db",
    );
    expect(() =>
      openSecureHostStateFilesystem(
        join(root, "wrong-app", "identities", "rcmi_test", HOST_STATE_DATABASE_BASENAME),
      ),
    ).toThrow("invalid layout");
  });
});
