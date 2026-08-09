import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHostStatePaths } from "./path.js";
import { HostStateOpenCleanupError, openHostStateDatabase } from "./sqlite.js";

const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.1 failed-open quarantine", () => {
  it("rejects later opens for a path whose live failed-open connection retained guardians", () => {
    const root = mkdtempSync(join(tmpdir(), "remote-claw-open-cleanup-"));
    temporaryRoots.push(root);
    const machineIdentityId = "67".repeat(16);
    const pathEnvironment = {
      xdgStateHome: join(root, "state"),
      homeDirectory: join(root, "home"),
    };
    const options = { machineIdentityId, pathEnvironment };
    openHostStateDatabase(options).close();

    const paths = resolveHostStatePaths(machineIdentityId, pathEnvironment);
    const editor = new DatabaseSync(paths.databasePath);
    editor.exec(`UPDATE host_state_metadata SET machine_identity_id='${"00".repeat(16)}'`);
    editor.close();

    const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(() => {
      throw new Error("simulated close that leaves SQLite open");
    });
    let failure: unknown;
    try {
      openHostStateDatabase(options);
    } catch (error) {
      failure = error;
    } finally {
      close.mockRestore();
    }
    expect(failure).toBeInstanceOf(HostStateOpenCleanupError);
    expect((failure as HostStateOpenCleanupError).guardiansRetained).toBe(true);
    expect((failure as HostStateOpenCleanupError).retryOpenSafe).toBe(false);

    expect(() => openHostStateDatabase(options)).toThrow(/process restart is required/);

    const independent = openHostStateDatabase({
      machineIdentityId: "68".repeat(16),
      pathEnvironment,
    });
    independent.close();
  });
});
