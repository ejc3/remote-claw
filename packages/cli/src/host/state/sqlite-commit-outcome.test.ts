import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseA1Digest } from "./ids.js";
import { ProtectedByteSnapshot } from "./protected.js";
import { HostStateCommitOutcomeUnknownError, openHostStateDatabase } from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.1 ordinary commit outcomes", () => {
  it("marks an unprovable COMMIT outcome as non-retry-safe and poisons the handle", () => {
    const root = mkdtempSync(
      join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-commit-outcome-"),
    );
    temporaryRoots.push(root);
    const database = openHostStateDatabase({
      machineIdentityId: "69".repeat(16),
      pathEnvironment: {
        xdgStateHome: join(root, "state"),
        homeDirectory: join(root, "home"),
      },
    });
    const originalExec = DatabaseSync.prototype.exec;
    let armed = false;
    let commitFailed = false;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (armed && sql === "COMMIT") {
        commitFailed = true;
        throw new Error("simulated unknown COMMIT outcome");
      }
      if (armed && commitFailed && sql === "ROLLBACK") {
        throw new Error("simulated rollback proof failure");
      }
      Reflect.apply(originalExec, this, [sql]);
    });
    armed = true;
    let failure: unknown;
    try {
      const bytes = Uint8Array.of(1);
      database.transaction((transaction) =>
        transaction.putArtifact({
          scopeKind: "host_profile",
          scopeId: "default",
          artifactSchemaId: "remote-claw/commit-outcome-test/v1",
          artifactDigest: parseA1Digest(createHash("sha256").update(bytes).digest("base64url")),
          artifactBytes: ProtectedByteSnapshot.from(bytes),
        }),
      );
    } catch (error) {
      failure = error;
    } finally {
      armed = false;
      exec.mockRestore();
    }

    expect(failure).toBeInstanceOf(HostStateCommitOutcomeUnknownError);
    expect((failure as HostStateCommitOutcomeUnknownError).outcome).toBe("unknown");
    expect((failure as HostStateCommitOutcomeUnknownError).retrySafe).toBe(false);
    expect(() => database.transaction(() => undefined)).toThrow(/poisoned/);
    database.close();
  });
});
