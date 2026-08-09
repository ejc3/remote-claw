import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Identity } from "@remote-claw/clawsec";
import { describe, expect, it, vi } from "vitest";
import { isRuntimeOwnerCliDirectInvocation, runRuntimeOwnerCli } from "./runtime-owner-cli.js";

function identity(machineByte: number): Identity {
  return {
    authToken: new Uint8Array(32).fill(1),
    identityId: new Uint8Array(16).fill(machineByte),
    contentRoot: new Uint8Array(32).fill(2),
    controlKey: new Uint8Array(32).fill(3),
    kMeta: new Uint8Array(32).fill(4),
  };
}

describe("private runtime-owner CLI", () => {
  it.skipIf(process.platform === "win32")(
    "recognizes direct invocation through an argv symlink",
    () => {
      const root = mkdtempSync(join(tmpdir(), "remote-claw-runtime-owner-cli-"));
      try {
        const target = fileURLToPath(new URL("./runtime-owner-cli.ts", import.meta.url));
        const entry = join(root, "runtime-owner-entry");
        symlinkSync(target, entry);

        expect(isRuntimeOwnerCliDirectInvocation(entry, pathToFileURL(target).href)).toBe(true);
        expect(
          isRuntimeOwnerCliDirectInvocation(join(root, "missing"), pathToFileURL(target).href),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects malformed private argv without reading a secret or reflecting argv", async () => {
    const output: string[] = [];
    const readSecret = vi.fn();
    const code = await runRuntimeOwnerCli(["--secret-file", "/contains/private/token"], {
      loadSecret: readSecret,
      stderr: (line) => output.push(line),
    });

    expect(code).toBe(2);
    expect(readSecret).not.toHaveBeenCalled();
    expect(output).toEqual(["remote-claw: runtime owner invocation is invalid\n"]);
    expect(output.join("")).not.toContain("private/token");
  });

  it("refuses a secret from another machine identity and erases every loaded byte", async () => {
    const rootSecret = new Uint8Array(32).fill(9);
    const derived = identity(0x11);
    const startDaemon = vi.fn();
    const output: string[] = [];
    const code = await runRuntimeOwnerCli(
      ["--machine-identity", "22".repeat(16), "--secret-file", "/state/remote-claw/secret"],
      {
        loadSecret: async () => ({ secret: rootSecret, createdAt: null }),
        deriveIdentity: async () => derived,
        startDaemon,
        stderr: (line) => output.push(line),
      },
    );

    expect(code).toBe(1);
    expect(startDaemon).not.toHaveBeenCalled();
    expect(rootSecret).toEqual(new Uint8Array(32));
    expect(derived.authToken).toEqual(new Uint8Array(32));
    expect(derived.identityId).toEqual(new Uint8Array(16));
    expect(derived.contentRoot).toEqual(new Uint8Array(32));
    expect(derived.controlKey).toEqual(new Uint8Array(32));
    expect(derived.kMeta).toEqual(new Uint8Array(32));
    expect(output).toEqual(["remote-claw: runtime owner is unavailable\n"]);
  });

  it("starts only the exact matching machine, waits for completion, and erases the secret", async () => {
    const rootSecret = new Uint8Array(32).fill(7);
    const derived = identity(0x33);
    let passedSecret: Uint8Array | undefined;
    let complete: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const run = runRuntimeOwnerCli(
      ["--secret-file", "/state/remote-claw/secret", "--machine-identity", "33".repeat(16)],
      {
        loadSecret: async () => ({ secret: rootSecret, createdAt: null }),
        deriveIdentity: async () => derived,
        startDaemon: async (options) => {
          passedSecret = options.identitySecret;
          return { completed };
        },
        stderr: () => {
          throw new Error("unexpected diagnostic");
        },
      },
    );

    await vi.waitFor(() => expect(passedSecret).toBe(rootSecret));
    expect(rootSecret).toEqual(new Uint8Array(32));
    complete?.();
    await expect(run).resolves.toBe(0);
    expect(derived.identityId).toEqual(new Uint8Array(16));
  });

  it("erases the secret when daemon startup fails without exposing the failure", async () => {
    const rootSecret = new Uint8Array(32).fill(5);
    const output: string[] = [];
    const code = await runRuntimeOwnerCli(
      ["--machine-identity", "44".repeat(16), "--secret-file", "/state/remote-claw/secret"],
      {
        loadSecret: async () => ({ secret: rootSecret, createdAt: null }),
        deriveIdentity: async () => identity(0x44),
        startDaemon: async () => {
          throw new Error("provider-token-super-secret");
        },
        stderr: (line) => output.push(line),
      },
    );

    expect(code).toBe(1);
    expect(rootSecret).toEqual(new Uint8Array(32));
    expect(output.join("")).not.toContain("provider-token-super-secret");
    expect(output).toEqual(["remote-claw: runtime owner is unavailable\n"]);
  });
});
