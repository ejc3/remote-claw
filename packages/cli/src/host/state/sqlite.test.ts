import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlDecode, base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { type A1Digest, parseA1Digest } from "./ids.js";
import {
  expectedHostStateMigrationDigest,
  expectedHostStateSqliteSchemaManifest,
  HOST_STATE_APPLICATION_ID,
  HOST_STATE_MIGRATIONS,
  HOST_STATE_SCHEMA_MANIFEST,
  HOST_STATE_SCHEMA_VERSION,
} from "./migrations.js";
import { resolveHostStatePaths } from "./path.js";
import {
  ProtectedByteSnapshot,
  type PutArtifactRequest,
  type PutArtifactResult,
  type ReadVerifiedArtifactRequest,
} from "./protected.js";
import {
  assertHostStateNodeVersion,
  type HostStateDatabase,
  type OpenHostStateDatabaseOptions,
  openHostStateDatabase,
  ProtectedArtifactPersistenceError,
} from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "42".repeat(16);
const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryDirectories: string[] = [];

function temporaryState() {
  const root = mkdtempSync(join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a11-sqlite-"));
  temporaryDirectories.push(root);
  const environment = {
    xdgStateHome: join(root, "state"),
    homeDirectory: join(root, "home"),
  };
  return {
    root,
    environment,
    paths: resolveHostStatePaths(MACHINE_IDENTITY_ID, environment),
  };
}

function digest(bytes: Uint8Array): A1Digest {
  return parseA1Digest(createHash("sha256").update(bytes).digest("base64url"));
}

function putRequest(bytes: Uint8Array): PutArtifactRequest {
  return {
    scopeKind: "host_profile",
    scopeId: "default",
    artifactSchemaId: "remote-claw/sqlite-test/v1",
    artifactDigest: digest(bytes),
    artifactBytes: ProtectedByteSnapshot.from(bytes),
  };
}

function openTestDatabase(state: ReturnType<typeof temporaryState>): HostStateDatabase {
  return openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: state.environment,
  });
}

function inspect(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
}

function downgradeFixture(databasePath: string, targetVersion: 1 | 2): void {
  const targetDigest = expectedHostStateMigrationDigest(targetVersion);
  const targetManifest = expectedHostStateSqliteSchemaManifest(targetVersion);
  const targetByName = new Map(targetManifest.map((entry) => [entry.name, entry]));
  const currentManifest = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION);
  const editor = new DatabaseSync(databasePath);
  try {
    editor.exec("PRAGMA foreign_keys=OFF");
    editor.exec("BEGIN IMMEDIATE");
    // The downgrade fixture must rewrite compiled migration history before
    // restoring the target version's append-only guard.
    editor.exec("DROP TRIGGER host_state_migrations_no_delete");
    for (const type of ["trigger", "index", "table"] as const) {
      for (const entry of [...currentManifest].reverse()) {
        if (entry.type !== type) continue;
        if (entry.name === "host_state_migrations_no_delete") continue;
        const target = targetByName.get(entry.name);
        if (target?.sql === entry.sql && target.type === entry.type) continue;
        editor.exec(`DROP ${type.toUpperCase()} "${entry.name}"`);
      }
    }
    const remaining = new Set(
      editor
        .prepare("SELECT name FROM sqlite_schema")
        .all()
        .map((row) => String(row.name)),
    );
    editor.prepare("DELETE FROM host_state_migrations WHERE schema_version > ?").run(targetVersion);
    editor
      .prepare(
        `UPDATE host_state_metadata
         SET schema_version = ?, migration_digest = ?
         WHERE singleton = 1`,
      )
      .run(targetVersion, targetDigest);
    for (const type of ["table", "index", "trigger"] as const) {
      for (const entry of targetManifest) {
        if (entry.type === type && !remaining.has(entry.name)) editor.exec(entry.sql);
      }
    }
    editor.exec(`PRAGMA user_version=${targetVersion}`);
    editor.exec("COMMIT");
  } catch (error) {
    try {
      editor.exec("ROLLBACK");
    } catch {
      // Preserve the fixture construction error.
    }
    throw error;
  } finally {
    editor.close();
  }
}

function mutateWithTriggerTemporarilyRemoved(
  database: DatabaseSync,
  triggerName: string,
  mutation: () => void,
): void {
  const trigger = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION).find(
    (entry) => entry.name === triggerName,
  );
  if (trigger === undefined) throw new Error(`missing ${triggerName} fixture`);
  database.exec(`DROP TRIGGER ${triggerName}`);
  try {
    mutation();
  } finally {
    database.exec(trigger.sql);
  }
}

function createCrashImageWithSchemaVersionOneInWal(state: ReturnType<typeof temporaryState>): void {
  for (const directory of [
    state.paths.stateHomePath,
    state.paths.applicationDirectoryPath,
    state.paths.identitiesDirectoryPath,
    state.paths.identityDirectoryPath,
  ]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  const sourcePath = join(state.root, "crash-source.db");
  const writer = new DatabaseSync(sourcePath);
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("PRAGMA synchronous=FULL");
    writer.exec("BEGIN IMMEDIATE");
    for (const migration of HOST_STATE_MIGRATIONS.slice(0, 1)) {
      for (const statement of migration.statements) writer.exec(statement);
      writer
        .prepare(
          `INSERT INTO host_state_migrations
             (schema_version, migration_id, migration_digest, applied_at_ms)
           VALUES (?, ?, ?, 1)`,
        )
        .run(migration.version, migration.id, expectedHostStateMigrationDigest(migration.version));
    }
    writer
      .prepare(
        `INSERT INTO host_state_metadata
           (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
         VALUES (1, ?, ?, ?, 1)`,
      )
      .run(MACHINE_IDENTITY_ID, 1, expectedHostStateMigrationDigest(1));
    writer.exec(`PRAGMA application_id=${HOST_STATE_APPLICATION_ID}`);
    writer.exec("PRAGMA user_version=1");
    writer.exec("COMMIT");

    copyFileSync(sourcePath, state.paths.databasePath);
    copyFileSync(`${sourcePath}-wal`, state.paths.walPath);
    chmodSync(state.paths.databasePath, 0o600);
    chmodSync(state.paths.walPath, 0o600);
  } finally {
    writer.close();
  }
}

function createCrashImageWithFutureSchemaVersionInWal(
  state: ReturnType<typeof temporaryState>,
): void {
  const source = temporaryState();
  openTestDatabase(source).close();
  const writer = new DatabaseSync(source.paths.databasePath);
  try {
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("BEGIN IMMEDIATE");
    writer.exec(`PRAGMA user_version=${HOST_STATE_SCHEMA_VERSION + 1}`);
    writer.exec("COMMIT");

    for (const directory of [
      state.paths.stateHomePath,
      state.paths.applicationDirectoryPath,
      state.paths.identitiesDirectoryPath,
      state.paths.identityDirectoryPath,
    ]) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    for (const suffix of ["", "-wal", "-shm"] as const) {
      copyFileSync(`${source.paths.databasePath}${suffix}`, `${state.paths.databasePath}${suffix}`);
      chmodSync(`${state.paths.databasePath}${suffix}`, 0o600);
    }
  } finally {
    writer.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("A1.1 Node.js runtime policy", () => {
  it("keeps entropy and clock injection out of the public database-open options", () => {
    expectTypeOf<keyof OpenHostStateDatabaseOptions>().toEqualTypeOf<
      "machineIdentityId" | "pathEnvironment"
    >();
  });

  it("accepts only runtimes with the selected secure node:sqlite options", () => {
    for (const version of ["22.13.0", "22.99.0", "23.5.0", "24.0.0", process.versions.node]) {
      expect(() => assertHostStateNodeVersion(version)).not.toThrow();
    }
    for (const version of ["21.99.0", "22.12.9", "22.13.0-pre", "23.0.0", "23.4.9", "invalid"]) {
      expect(() => assertHostStateNodeVersion(version)).toThrow(
        /requires Node|could not be verified/,
      );
    }
  });
});

describeLinux("A1.1 secure host-state database", () => {
  it("creates, validates, and reopens the exact owner-only WAL schema", () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    try {
      expect(database.machineIdentityId).toBe(MACHINE_IDENTITY_ID);
      expect(database.databasePath).toBe(state.paths.databasePath);
      expect(database.schemaVersion).toBe(HOST_STATE_SCHEMA_VERSION);
      expect(statSync(state.paths.applicationDirectoryPath).mode & 0o777).toBe(0o700);
      expect(statSync(state.paths.identitiesDirectoryPath).mode & 0o777).toBe(0o700);
      expect(statSync(state.paths.identityDirectoryPath).mode & 0o777).toBe(0o700);
      for (const path of [state.paths.databasePath, state.paths.walPath, state.paths.shmPath]) {
        const stat = statSync(path);
        expect(stat.isFile()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o600);
        expect(stat.nlink).toBe(1);
      }

      const inspection = inspect(state.paths.databasePath);
      try {
        expect(inspection.prepare("PRAGMA application_id").get()).toEqual({
          application_id: HOST_STATE_APPLICATION_ID,
        });
        expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
          user_version: HOST_STATE_SCHEMA_VERSION,
        });
        expect(inspection.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(
          inspection
            .prepare(
              `SELECT machine_identity_id, schema_version, migration_digest
               FROM host_state_metadata WHERE singleton = 1`,
            )
            .get(),
        ).toEqual({
          machine_identity_id: MACHINE_IDENTITY_ID,
          schema_version: HOST_STATE_SCHEMA_VERSION,
          migration_digest: HOST_STATE_SCHEMA_MANIFEST.migrationDigest,
        });
      } finally {
        inspection.close();
      }
    } finally {
      database.close();
    }

    const reopened = openTestDatabase(state);
    reopened.close();
  });

  it("validates a locked version-one database before migrating it atomically to the current schema", () => {
    const state = temporaryState();
    openTestDatabase(state).close();
    downgradeFixture(state.paths.databasePath, 1);

    const before = inspect(state.paths.databasePath);
    try {
      expect(before.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(before.prepare("SELECT count(*) AS count FROM host_state_migrations").get()).toEqual({
        count: 1,
      });
    } finally {
      before.close();
    }

    openTestDatabase(state).close();
    const after = inspect(state.paths.databasePath);
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HOST_STATE_SCHEMA_VERSION,
      });
      expect(after.prepare("SELECT count(*) AS count FROM host_state_migrations").get()).toEqual({
        count: HOST_STATE_SCHEMA_VERSION,
      });
      expect(
        after
          .prepare("SELECT migration_digest FROM host_state_migrations WHERE schema_version = ?")
          .get(HOST_STATE_SCHEMA_VERSION),
      ).toEqual({ migration_digest: HOST_STATE_SCHEMA_MANIFEST.migrationDigest });
    } finally {
      after.close();
    }
  });

  it("validates schema version two before adding the dormant durable-record repository", () => {
    const state = temporaryState();
    openTestDatabase(state).close();
    downgradeFixture(state.paths.databasePath, 2);

    const before = inspect(state.paths.databasePath);
    try {
      expect(before.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(before.prepare("SELECT count(*) AS count FROM host_state_migrations").get()).toEqual({
        count: 2,
      });
      expect(() => before.prepare("SELECT count(*) AS count FROM collaboration_servers")).toThrow(
        /no such table/,
      );
    } finally {
      before.close();
    }

    openTestDatabase(state).close();
    const after = inspect(state.paths.databasePath);
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HOST_STATE_SCHEMA_VERSION,
      });
      expect(after.prepare("SELECT count(*) AS count FROM host_state_migrations").get()).toEqual({
        count: HOST_STATE_SCHEMA_VERSION,
      });
      expect(after.prepare("SELECT count(*) AS count FROM collaboration_servers").get()).toEqual({
        count: 0,
      });
    } finally {
      after.close();
    }
  });

  it("keeps a committed migration successful when an older reader defers its checkpoint", () => {
    const state = temporaryState();
    openTestDatabase(state).close();
    downgradeFixture(state.paths.databasePath, 1);
    const reader = new DatabaseSync(state.paths.databasePath, { readOnly: true });
    reader.exec("BEGIN");
    expect(reader.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    reader.prepare("SELECT count(*) FROM host_state_migrations").get();

    try {
      const migrated = openTestDatabase(state);
      migrated.close();
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }

    const inspection = inspect(state.paths.databasePath);
    try {
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HOST_STATE_SCHEMA_VERSION,
      });
    } finally {
      inspection.close();
    }
  });

  it("recovers a committed version-one crash WAL whose main header is still version zero", () => {
    const state = temporaryState();
    createCrashImageWithSchemaVersionOneInWal(state);
    const mainHeader = readFileSync(state.paths.databasePath).subarray(0, 100);
    expect(mainHeader.readUInt32BE(60)).toBe(0);
    expect(mainHeader.readUInt32BE(68)).toBe(0);
    expect(statSync(state.paths.walPath).size).toBeGreaterThan(0);
    expect(() => statSync(state.paths.shmPath)).toThrow();

    openTestDatabase(state).close();
    const inspection = inspect(state.paths.databasePath);
    try {
      expect(inspection.prepare("PRAGMA application_id").get()).toEqual({
        application_id: HOST_STATE_APPLICATION_ID,
      });
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HOST_STATE_SCHEMA_VERSION,
      });
      expect(
        inspection.prepare("SELECT count(*) AS count FROM host_state_migrations").get(),
      ).toEqual({
        count: HOST_STATE_SCHEMA_VERSION,
      });
    } finally {
      inspection.close();
    }
  });

  it("rejects a future version committed only in WAL without rewriting main or WAL", () => {
    const state = temporaryState();
    createCrashImageWithFutureSchemaVersionInWal(state);
    const mainBefore = readFileSync(state.paths.databasePath);
    const walBefore = readFileSync(state.paths.walPath);
    const entriesBefore = readdirSync(state.paths.identityDirectoryPath).sort();

    expect(mainBefore.subarray(0, 16).toString("ascii")).toBe("SQLite format 3\0");
    expect(mainBefore.readUInt32BE(60)).toBe(HOST_STATE_SCHEMA_VERSION);
    expect(walBefore.byteLength).toBeGreaterThan(0);
    expect(entriesBefore).toEqual(
      [
        basename(state.paths.databasePath),
        basename(state.paths.shmPath),
        basename(state.paths.walPath),
      ].sort(),
    );

    expect(() => openTestDatabase(state)).toThrow(/newer than this build supports/);

    expect(readFileSync(state.paths.databasePath)).toEqual(mainBefore);
    expect(readFileSync(state.paths.walPath)).toEqual(walBefore);
    expect(readdirSync(state.paths.identityDirectoryPath).sort()).toEqual(entriesBefore);
    // SHM contains transient SQLite coordination state and may change even on
    // a read-only open; its guarded path and owner-only file contract remain.
    const shm = statSync(state.paths.shmPath);
    expect(shm.isFile()).toBe(true);
    expect(shm.mode & 0o777).toBe(0o600);
    expect(shm.nlink).toBe(1);
  });

  it("reconstructs WAL state when a crash leaves only a safe SHM sidecar", () => {
    const state = temporaryState();
    openTestDatabase(state).close();
    const editor = new DatabaseSync(state.paths.databasePath);
    editor.exec("PRAGMA wal_autocheckpoint=0");
    editor.exec("BEGIN IMMEDIATE");
    editor.exec("UPDATE host_state_metadata SET created_at_ms = created_at_ms");
    editor.exec("COMMIT");
    const staleShm = readFileSync(state.paths.shmPath);
    editor.close();
    expect(staleShm.byteLength).toBeGreaterThan(0);
    rmSync(state.paths.walPath, { force: true });
    rmSync(state.paths.shmPath, { force: true });
    writeFileSync(state.paths.shmPath, staleShm, { mode: 0o600 });

    const reopened = openTestDatabase(state);
    reopened.close();

    const inspection = inspect(state.paths.databasePath);
    try {
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HOST_STATE_SCHEMA_VERSION,
      });
    } finally {
      inspection.close();
    }
  });

  it("persists protected artifacts across reopen without exposing mutable bytes", async () => {
    const state = temporaryState();
    const source = Uint8Array.of(1, 2, 3, 4);
    const request = putRequest(source);
    source.fill(0xff);
    const database = openTestDatabase(state);
    const put = await database.putArtifact(request);
    database.close();

    const reopened = openTestDatabase(state);
    try {
      const read = await reopened.readVerifiedArtifact({
        scopeKind: put.scopeKind,
        scopeId: put.scopeId,
        artifactRef: put.artifactRef,
        artifactSchemaId: put.artifactSchemaId,
        expectedArtifactDigest: put.artifactDigest,
      } as ReadVerifiedArtifactRequest);
      const first = read.artifactBytes.copyBytes();
      first.fill(0);
      expect(read.artifactBytes.copyBytes()).toEqual(Uint8Array.of(1, 2, 3, 4));
    } finally {
      reopened.close();
    }
  });

  it("poisons the live handle on a protected-artifact storage failure", async () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    const put = await database.putArtifact(putRequest(Uint8Array.of(1)));
    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      editor.exec("DROP TABLE protected_artifacts");
    } finally {
      editor.close();
    }
    await expect(
      database.readVerifiedArtifact({
        scopeKind: put.scopeKind,
        scopeId: put.scopeId,
        artifactRef: put.artifactRef,
        artifactSchemaId: put.artifactSchemaId,
        expectedArtifactDigest: put.artifactDigest,
      } as ReadVerifiedArtifactRequest),
    ).rejects.toBeInstanceOf(ProtectedArtifactPersistenceError);
    expect(() => database.transaction(() => undefined)).toThrow(/poisoned/);
    database.close();
  });

  it("reports a committed write as success while another SQLite reader defers checkpointing", async () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    const reader = new DatabaseSync(state.paths.databasePath, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) AS count FROM protected_artifacts").get();
    try {
      const put = await database.putArtifact(putRequest(Uint8Array.of(9)));
      expect(put.byteLength).toBe(1);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
      database.close();
    }

    const inspection = inspect(state.paths.databasePath);
    try {
      expect(inspection.prepare("SELECT count(*) AS count FROM protected_artifacts").get()).toEqual(
        {
          count: 1,
        },
      );
    } finally {
      inspection.close();
    }
  });

  it("commits multiple high-level operations atomically and rolls back throws and thenables", () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    try {
      const committed = database.transaction((transaction) => [
        transaction.putArtifact(putRequest(Uint8Array.of(1))),
        transaction.putArtifact(putRequest(Uint8Array.of(2))),
      ]);
      expect(committed).toHaveLength(2);

      let rolledBackRef: PutArtifactResult | null = null;
      expect(() =>
        database.transaction((transaction) => {
          rolledBackRef = transaction.putArtifact(putRequest(Uint8Array.of(3)));
          throw new Error("rollback sentinel");
        }),
      ).toThrow("rollback sentinel");
      expect(rolledBackRef).not.toBeNull();
      const rolledBack = rolledBackRef as PutArtifactResult | null;
      if (rolledBack === null) throw new Error("missing rolled-back reference");

      expect(() =>
        database.transaction((transaction) =>
          transaction.readVerifiedArtifact({
            scopeKind: rolledBack.scopeKind,
            scopeId: rolledBack.scopeId,
            artifactRef: rolledBack.artifactRef,
            artifactSchemaId: rolledBack.artifactSchemaId,
            expectedArtifactDigest: rolledBack.artifactDigest,
          } as ReadVerifiedArtifactRequest),
        ),
      ).toThrow(/could not be verified/);

      expect(() =>
        database.transaction((() => Promise.resolve("not synchronous")) as never),
      ).toThrow(/must be synchronous/);
    } finally {
      database.close();
    }
  });

  it("synchronously rejects database-level async operations inside a transaction callback", () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    expect(() =>
      database.transaction((transaction) => {
        transaction.putArtifact(putRequest(Uint8Array.of(1)));
        void database.putArtifact(putRequest(Uint8Array.of(2)));
      }),
    ).toThrow(/database-level artifact operations cannot run inside/);
    database.close();

    const inspection = inspect(state.paths.databasePath);
    try {
      expect(inspection.prepare("SELECT count(*) AS count FROM protected_artifacts").get()).toEqual(
        { count: 0 },
      );
    } finally {
      inspection.close();
    }
  });

  it("observes late rejection from a forbidden async transaction callback", async () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    const unhandled: unknown[] = [];
    let lateAuthorityError: unknown;
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.prependListener("unhandledRejection", onUnhandled);
    try {
      expect(() =>
        database.transaction(async () => {
          await Promise.resolve();
          try {
            await database.putArtifact(putRequest(Uint8Array.of(99)));
          } catch (error) {
            lateAuthorityError = error;
          }
          throw new Error("late async rejection");
        }),
      ).toThrow(/must be synchronous/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(String(lateAuthorityError)).toMatch(/poisoned/);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      database.close();
    }
    const inspection = inspect(state.paths.databasePath);
    try {
      expect(inspection.prepare("SELECT count(*) AS count FROM protected_artifacts").get()).toEqual(
        {
          count: 0,
        },
      );
    } finally {
      inspection.close();
    }
  });

  it("poisons before hostile promise species or thenability inspection can reenter", async () => {
    for (const resultKind of ["promise", "proxy"] as const) {
      const state = temporaryState();
      const database = openTestDatabase(state);
      let lateAuthorityError: unknown;
      let proxyTrapEntered = false;
      let result: unknown;
      if (resultKind === "promise") {
        const promise = (async () => {
          await Promise.resolve();
          try {
            await database.putArtifact(putRequest(Uint8Array.of(88)));
          } catch (error) {
            lateAuthorityError = error;
          }
        })();
        Object.defineProperty(promise, "constructor", {
          get() {
            throw new Error("hostile promise constructor");
          },
        });
        result = promise;
      } else {
        result = new Proxy(
          {},
          {
            has() {
              proxyTrapEntered = true;
              database.transaction(() => undefined);
              return true;
            },
          },
        );
      }

      expect(() => database.transaction((() => result) as never)).toThrow(
        /synchronous|inspected safely/,
      );
      expect(() => database.transaction(() => undefined)).toThrow(/poisoned/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (resultKind === "promise") expect(String(lateAuthorityError)).toMatch(/poisoned/);
      if (resultKind === "proxy") expect(proxyTrapEntered).toBe(false);
      database.close();

      const inspection = inspect(state.paths.databasePath);
      try {
        expect(
          inspection.prepare("SELECT count(*) AS count FROM protected_artifacts").get(),
        ).toEqual({ count: 0 });
      } finally {
        inspection.close();
      }
    }
  });

  it("returns plain synchronous objects but rejects ordinary thenables", () => {
    const state = temporaryState();
    const plainDatabase = openTestDatabase(state);
    expect(plainDatabase.transaction(() => ({ value: 1 }))).toEqual({ value: 1 });
    plainDatabase.close();

    const thenableDatabase = openTestDatabase(state);
    // biome-ignore lint/suspicious/noThenProperty: this is the intentional rejection fixture.
    const thenable = Object.defineProperty({}, "then", { value() {} });
    expect(() => thenableDatabase.transaction((() => thenable) as never)).toThrow(
      /must be synchronous/,
    );
    expect(() => thenableDatabase.transaction(() => undefined)).toThrow(/poisoned/);
    thenableDatabase.close();
  });

  it("invalidates escaped transactions and rejects use after close", () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    expect(() => database.transaction(() => database.close())).toThrow(
      /cannot close during a transaction/,
    );
    expect(() => database.transaction(() => database.transaction(() => undefined))).toThrow(
      /nested transactions/,
    );
    expect(database.transaction(() => "still usable")).toBe("still usable");
    const escaped = database.transaction((transaction) => transaction);
    expect(() => escaped.putArtifact(putRequest(Uint8Array.of(1)))).toThrow(/escaped/);
    database.close();
    expect(() => database.transaction(() => undefined)).toThrow(/closed/);
    expect(() => database.putArtifact(putRequest(Uint8Array.of(1)))).toThrow(/closed/);
    database.close();
  });

  it("retains filesystem guardians and permits retry when SQLite close stays open", () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
      throw new Error("simulated close failure");
    });
    try {
      expect(() => database.close()).toThrow(/guardians remain held/);
      expect(() => database.transaction(() => undefined)).toThrow(/closed/);
      expect(() => database.close()).not.toThrow();
    } finally {
      close.mockRestore();
      database.close();
    }
  });

  it("rolls back and poisons the handle when its guarded path changes mid-transaction", () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    expect(() =>
      database.transaction(() => {
        renameSync(state.paths.databasePath, `${state.paths.databasePath}.moved`);
        writeFileSync(state.paths.databasePath, "", { mode: 0o600 });
        return "must not commit";
      }),
    ).toThrow(/path identity changed/);
    expect(() => database.transaction(() => undefined)).toThrow(/poisoned/);
    expect(() => database.close()).toThrow(/path identity changed/);
  });

  it("refuses future, wrong-identity, wrong-digest, and edited-schema state", () => {
    const corruptions: readonly ((database: DatabaseSync) => void)[] = [
      (database) => database.exec(`PRAGMA user_version=${HOST_STATE_SCHEMA_VERSION + 1}`),
      (database) =>
        database.exec(`UPDATE host_state_metadata SET machine_identity_id='${"00".repeat(16)}'`),
      (database) =>
        database.exec(
          "UPDATE host_state_metadata SET migration_digest='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'",
        ),
      (database) => database.exec("CREATE TABLE injected_schema (id INTEGER PRIMARY KEY) STRICT"),
    ];

    for (const corrupt of corruptions) {
      const state = temporaryState();
      openTestDatabase(state).close();
      const editor = new DatabaseSync(state.paths.databasePath);
      try {
        corrupt(editor);
      } finally {
        editor.close();
      }
      expect(() => openTestDatabase(state)).toThrow(/host state storage rejected/);
    }
  });

  it("refuses changed, missing, and extra migration-history rows", () => {
    const mutations: readonly ((database: DatabaseSync) => void)[] = [
      (database) =>
        mutateWithTriggerTemporarilyRemoved(database, "host_state_migrations_no_update", () =>
          database.exec(
            "UPDATE host_state_migrations SET migration_id='changed-id' WHERE schema_version=2",
          ),
        ),
      (database) =>
        mutateWithTriggerTemporarilyRemoved(database, "host_state_migrations_no_update", () =>
          database.exec(
            "UPDATE host_state_migrations SET migration_digest='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE schema_version=2",
          ),
        ),
      (database) =>
        mutateWithTriggerTemporarilyRemoved(database, "host_state_migrations_no_delete", () =>
          database.exec("DELETE FROM host_state_migrations WHERE schema_version=2"),
        ),
      (database) =>
        database
          .prepare(
            `INSERT INTO host_state_migrations
               (schema_version, migration_id, migration_digest, applied_at_ms)
             VALUES (?, 'unexpected-extra', ?, 1)`,
          )
          .run(HOST_STATE_SCHEMA_VERSION + 1, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ];

    for (const mutate of mutations) {
      const state = temporaryState();
      openTestDatabase(state).close();
      const editor = new DatabaseSync(state.paths.databasePath);
      try {
        mutate(editor);
      } finally {
        editor.close();
      }
      expect(() => openTestDatabase(state)).toThrow(/migration (history|ID|digest)/);
    }
  });

  it("refuses a database whose b-tree integrity no longer matches its exact schema", () => {
    const state = temporaryState();
    openTestDatabase(state).close();
    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      editor.exec("PRAGMA writable_schema=ON");
      editor.exec(
        `UPDATE sqlite_schema
         SET rootpage = (
           SELECT rootpage FROM sqlite_schema
           WHERE type = 'table' AND name = 'host_state_metadata'
         )
         WHERE type = 'table' AND name = 'protected_artifacts'`,
      );
      editor.exec("PRAGMA writable_schema=OFF");
    } finally {
      editor.close();
    }
    expect(() => openTestDatabase(state)).toThrow(/malformed|integrity/i);
  });

  it("refuses hidden sqlite_-prefixed schema objects", () => {
    const state = temporaryState();
    openTestDatabase(state).close();
    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      editor.exec("PRAGMA writable_schema=ON");
      editor
        .prepare(
          `INSERT INTO sqlite_schema (type, name, tbl_name, rootpage, sql)
           VALUES ('trigger', 'sqlite_evil', 'protected_artifacts', 0, ?)`,
        )
        .run(
          `CREATE TRIGGER sqlite_evil AFTER INSERT ON protected_artifacts
           BEGIN
             UPDATE host_state_metadata SET created_at_ms = created_at_ms + 1;
           END`,
        );
      editor.exec("PRAGMA writable_schema=OFF");
    } finally {
      editor.close();
    }

    expect(() => openTestDatabase(state)).toThrow(/schema manifest has missing or extra objects/);
  });

  it("refuses a wrong application id and does not rewrite a future database", () => {
    const wrong = temporaryState();
    openTestDatabase(wrong).close();
    const wrongEditor = new DatabaseSync(wrong.paths.databasePath);
    wrongEditor.exec("PRAGMA application_id=1");
    wrongEditor.close();
    expect(() => openTestDatabase(wrong)).toThrow(/application_id/);

    const future = temporaryState();
    openTestDatabase(future).close();
    const futureEditor = new DatabaseSync(future.paths.databasePath);
    futureEditor.exec(`PRAGMA user_version=${HOST_STATE_SCHEMA_VERSION + 1}`);
    futureEditor.close();
    const before = readFileSync(future.paths.databasePath);
    const entriesBefore = readdirSync(future.paths.identityDirectoryPath).sort();
    const directoryMtimeBefore = statSync(future.paths.identityDirectoryPath, {
      bigint: true,
    }).mtimeNs;
    expect(() => openTestDatabase(future)).toThrow(/newer than this build supports/);
    expect(readFileSync(future.paths.databasePath)).toEqual(before);
    expect(readdirSync(future.paths.identityDirectoryPath).sort()).toEqual(entriesBefore);
    expect(statSync(future.paths.identityDirectoryPath, { bigint: true }).mtimeNs).toBe(
      directoryMtimeBefore,
    );
  });

  it("refuses a non-WAL header before SQLite can convert it", () => {
    const state = temporaryState();
    openTestDatabase(state).close();
    const editor = new DatabaseSync(state.paths.databasePath);
    expect(editor.prepare("PRAGMA journal_mode=DELETE").get()).toEqual({ journal_mode: "delete" });
    editor.close();
    expect(() => openTestDatabase(state)).toThrow(/not a WAL database/);
  });

  it("allocates canonical 16-byte opaque artifact handles", async () => {
    const state = temporaryState();
    const database = openTestDatabase(state);
    try {
      const result = await database.putArtifact(putRequest(Uint8Array.of()));
      const encoded = result.artifactRef.protectedHandleId.slice("rcph_".length);
      const decoded = base64urlDecode(encoded);
      expect(decoded).toHaveLength(16);
      expect(result.artifactRef.protectedHandleId).toBe(`rcph_${base64urlEncode(decoded)}`);
    } finally {
      database.close();
    }
  });
});
