import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      return {
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
    },
  };
});

import { HostStateMigrationCommittedError, openHostStateDatabase } from "./sqlite.js";

const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid);
const temporaryRoots: string[] = [];

afterEach(() => {
  fsyncControl.failNext = false;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.1 migration commit outcomes", () => {
  it("reports a post-commit finalization failure and safely completes on reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "remote-claw-migration-outcome-"));
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
