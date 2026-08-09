import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsyncControl = vi.hoisted(() => ({ failNext: false }));

vi.mock("./secure-filesystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./secure-filesystem.js")>();
  return {
    ...actual,
    openSecureHostStateFilesystem: (
      ...args: Parameters<typeof actual.openSecureHostStateFilesystem>
    ) => {
      const guardian = actual.openSecureHostStateFilesystem(...args);
      const wrapped: SecureHostStateFilesystem = {
        databasePath: guardian.databasePath,
        databaseDescriptorPath: guardian.databaseDescriptorPath,
        databaseWasCreated: guardian.databaseWasCreated,
        filesystem: guardian.filesystem,
        assertStable: () => guardian.assertStable(),
        fsync: () => {
          if (fsyncControl.failNext) {
            fsyncControl.failNext = false;
            throw new Error("simulated post-migration fsync failure");
          }
          guardian.fsync();
        },
        close: () => guardian.close(),
      };
      return wrapped;
    },
  };
});

import { HOST_STATE_SCHEMA_VERSION } from "./migrations.js";
import type { SecureHostStateFilesystem } from "./secure-filesystem.js";
import { HostStateMigrationCommittedError, openHostStateDatabase } from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];

afterEach(() => {
  fsyncControl.failNext = false;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.1 migration commit outcomes", () => {
  it("accepts the passive-checkpoint busy sentinel after a durable migration commit", () => {
    const root = mkdtempSync(
      join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-checkpoint-busy-"),
    );
    temporaryRoots.push(root);
    const originalPrepare = DatabaseSync.prototype.prepare;
    let checkpointCalls = 0;
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql === "PRAGMA wal_checkpoint(PASSIVE)") {
        checkpointCalls++;
        return {
          get: () => ({ busy: 1, log: -1, checkpointed: -1 }),
        } as unknown as StatementSync;
      }
      return Reflect.apply(originalPrepare, this, [sql]);
    });
    try {
      const database = openHostStateDatabase({
        machineIdentityId: "65".repeat(16),
        pathEnvironment: {
          xdgStateHome: join(root, "state"),
          homeDirectory: join(root, "home"),
        },
      });
      database.close();
    } finally {
      prepare.mockRestore();
    }
    expect(checkpointCalls).toBe(HOST_STATE_SCHEMA_VERSION);
  });

  it("reports a post-commit finalization failure and safely completes on reopen", () => {
    const root = mkdtempSync(
      join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-migration-outcome-"),
    );
    temporaryRoots.push(root);
    const options = {
      machineIdentityId: "66".repeat(16),
      pathEnvironment: {
        xdgStateHome: join(root, "state"),
        homeDirectory: join(root, "home"),
      },
    };

    fsyncControl.failNext = true;
    let failure: unknown;
    try {
      openHostStateDatabase(options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HostStateMigrationCommittedError);
    expect((failure as HostStateMigrationCommittedError).committed).toBe(true);
    expect((failure as HostStateMigrationCommittedError).retryOpenSafe).toBe(true);

    const recovered = openHostStateDatabase(options);
    recovered.close();
  });
});
