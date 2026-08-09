import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const guardianControl = vi.hoisted(() => ({
  armed: false,
  assertCalls: 0,
  committedWalBytes: 0,
  mutateAtAssert: 0,
  mutation: null as (() => void) | null,
}));

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
        assertStable: () => {
          if (guardianControl.armed) {
            guardianControl.assertCalls++;
            if (guardianControl.assertCalls === guardianControl.mutateAtAssert) {
              guardianControl.mutation?.();
            }
          }
          guardian.assertStable();
        },
        fsync: () => guardian.fsync(),
        close: () => guardian.close(),
      };
      return wrapped;
    },
  };
});

import { parseA1Digest } from "./ids.js";
import { ProtectedByteSnapshot } from "./protected.js";
import type { SecureHostStateFilesystem } from "./secure-filesystem.js";
import { HostStateCommittedStateError, openHostStateDatabase } from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];
const POST_BEGIN_GUARD_CHECK = 2;
const POST_COMMIT_GUARD_CHECK = 4;
const CATCH_PATH_GUARD_CHECK = 5;

afterEach(() => {
  guardianControl.armed = false;
  guardianControl.assertCalls = 0;
  guardianControl.committedWalBytes = 0;
  guardianControl.mutateAtAssert = 0;
  guardianControl.mutation = null;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.1 post-commit guardian outcome", () => {
  it("reports committed state distinctly when the canonical path changes after COMMIT", async () => {
    const root = mkdtempSync(join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-postcommit-"));
    temporaryRoots.push(root);
    const identity = "55".repeat(16);
    const database = openHostStateDatabase({
      machineIdentityId: identity,
      pathEnvironment: {
        xdgStateHome: join(root, "state"),
        homeDirectory: join(root, "home"),
      },
    });
    const movedPath = `${database.databasePath}.committed`;
    guardianControl.mutateAtAssert = POST_COMMIT_GUARD_CHECK;
    guardianControl.mutation = () => {
      guardianControl.committedWalBytes = statSync(`${database.databasePath}-wal`).size;
      renameSync(database.databasePath, movedPath);
      writeFileSync(database.databasePath, "", { mode: 0o600 });
    };
    guardianControl.armed = true;

    const bytes = Uint8Array.of(7);
    let failure: unknown;
    try {
      await database.putArtifact({
        scopeKind: "host_profile",
        scopeId: "default",
        artifactSchemaId: "remote-claw/postcommit-test/v1",
        artifactDigest: parseA1Digest(createHash("sha256").update(bytes).digest("base64url")),
        artifactBytes: ProtectedByteSnapshot.from(bytes),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HostStateCommittedStateError);
    expect((failure as HostStateCommittedStateError).committed).toBe(true);
    expect(guardianControl.committedWalBytes).toBeGreaterThan(0);
    // The catch path performs one final guard check after the post-COMMIT mutation.
    expect(guardianControl.assertCalls).toBe(CATCH_PATH_GUARD_CHECK);
    expect(() => database.transaction(() => undefined)).toThrow(/poisoned/);
    expect(() => database.close()).toThrow(/path identity changed/);
  });

  it("revalidates guardians after acquiring the writer lock and before the callback", () => {
    const root = mkdtempSync(join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-postlock-"));
    temporaryRoots.push(root);
    const database = openHostStateDatabase({
      machineIdentityId: "56".repeat(16),
      pathEnvironment: {
        xdgStateHome: join(root, "state"),
        homeDirectory: join(root, "home"),
      },
    });
    const movedPath = `${database.databasePath}.before-callback`;
    let callbackEntered = false;
    guardianControl.mutateAtAssert = POST_BEGIN_GUARD_CHECK;
    guardianControl.mutation = () => {
      renameSync(database.databasePath, movedPath);
      writeFileSync(database.databasePath, "", { mode: 0o600 });
    };
    guardianControl.armed = true;

    expect(() =>
      database.transaction(() => {
        callbackEntered = true;
      }),
    ).toThrow(/path identity changed/);
    expect(callbackEntered).toBe(false);
    expect(() => database.transaction(() => undefined)).toThrow(/poisoned/);
    expect(() => database.close()).toThrow(/path identity changed/);
  });
});
