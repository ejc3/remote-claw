import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeExecutableChunkManifest,
  MAX_EXECUTABLE_BYTES,
} from "../state/native-binding-authority-executable-evidence.js";
import {
  collectLinuxExecutableEvidence,
  LinuxExecutableCollectionError,
} from "./linux-executable-collector.js";

const describeLinux = process.platform === "linux" ? describe : describe.skip;
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "remote-claw-executable-evidence-"));
  roots.push(value);
  return value;
}

function executable(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function processDescriptorTargets(): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const entry of readdirSync("/proc/self/fd")) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(entry)) continue;
    try {
      targets.add(readlinkSync(`/proc/self/fd/${entry}`));
    } catch {
      // Descriptor is absent or raced closed.
    }
  }
  return targets;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describeLinux("Linux executable evidence collector", () => {
  it("rejects an invalid runtime role before opening the path", async () => {
    await expect(
      collectLinuxExecutableEvidence(
        "/definitely/not/opened",
        "listener.generated_surface" as "listener.native_executable",
      ),
    ).rejects.toMatchObject({ code: "INVALID_ROLE" });
  });

  it("collects two stable passes from one regular executable and closes the descriptor", async () => {
    const directory = root();
    const path = join(directory, "native");
    const bytes = new TextEncoder().encode("#!/bin/sh\nprintf measured\n");
    executable(path, bytes);

    const collected = await collectLinuxExecutableEvidence(path, "listener.native_executable");
    expect(collected.manifest).toMatchObject({
      fileByteLength: bytes.byteLength,
      chunkCount: 1,
      rawFileSha256: "37Guujm2x3YG84N_jCVpRMgPRwBfx2-pFZVUkpOB--4",
    });
    expect(
      await decodeExecutableChunkManifest(
        collected.canonicalBytes.copyBytes(),
        "listener.native_executable",
      ),
    ).toEqual(collected.manifest);
    expect(collected.commitment).toMatchObject({
      role: "listener.native_executable",
      artifactSchemaId: "remote-claw/native-executable-chunk-manifest/v1",
      byteLength: collected.canonicalBytes.byteLength,
    });

    // A closed collector descriptor cannot retain a deleted pathname under /proc/self/fd.
    const linked = processDescriptorTargets();
    expect([...linked].some((target) => target === path || target === `${path} (deleted)`)).toBe(
      false,
    );
  });

  it("refuses symlinks, directories, and FIFOs without blocking", async () => {
    const directory = root();
    const target = join(directory, "target");
    executable(target, Uint8Array.of(1));
    const link = join(directory, "link");
    symlinkSync(target, link);
    await expect(
      collectLinuxExecutableEvidence(link, "listener.native_executable"),
    ).rejects.toMatchObject({ code: "SYMLINK_REFUSED" });
    await expect(
      collectLinuxExecutableEvidence(directory, "listener.native_executable"),
    ).rejects.toMatchObject({ code: "NOT_REGULAR" });

    const fifo = join(directory, "fifo");
    execFileSync("mkfifo", [fifo]);
    await expect(
      Promise.race([
        collectLinuxExecutableEvidence(fifo, "listener.native_executable"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO open blocked")), 1_000)),
      ]),
    ).rejects.toMatchObject({ code: "NOT_REGULAR" });
  });

  it("rejects empty, non-executable, and sparse 256 MiB + 1 files before reading", async () => {
    const directory = root();
    const empty = join(directory, "empty");
    executable(empty, new Uint8Array());
    await expect(
      collectLinuxExecutableEvidence(empty, "listener.native_executable"),
    ).rejects.toMatchObject({ code: "EMPTY" });

    const noExec = join(directory, "no-exec");
    writeFileSync(noExec, Uint8Array.of(1), { mode: 0o600 });
    chmodSync(noExec, 0o600);
    await expect(
      collectLinuxExecutableEvidence(noExec, "listener.native_executable"),
    ).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });

    const oversized = join(directory, "oversized");
    const fd = openSync(oversized, "w", 0o700);
    try {
      ftruncateSync(fd, MAX_EXECUTABLE_BYTES + 1);
    } finally {
      closeSync(fd);
    }
    chmodSync(oversized, 0o700);
    await expect(
      collectLinuxExecutableEvidence(oversized, "listener.native_executable"),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("aborts before collection without exposing a partial result", async () => {
    const directory = root();
    const path = join(directory, "native");
    executable(path, new Uint8Array(4 * 1_048_576).fill(5));
    const controller = new AbortController();
    controller.abort();
    let result: unknown;
    await expect(
      collectLinuxExecutableEvidence(path, "listener.native_executable", {
        signal: controller.signal,
      }).then((value) => {
        result = value;
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(result).toBeUndefined();
  });

  it("closes the opened descriptor when cancellation lands after the first positional read", async () => {
    const directory = root();
    const path = join(directory, "native");
    executable(path, new Uint8Array(4 * 1_048_576).fill(6));
    const controller = new AbortController();
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...args: readonly unknown[]) => Promise<unknown>;
    };
    const originalRead = prototype.read;
    await probe.close();
    let completedReads = 0;
    prototype.read = async function (this: object, ...args: readonly unknown[]): Promise<unknown> {
      const result = await Reflect.apply(originalRead, this, args);
      completedReads++;
      if (completedReads === 1) controller.abort();
      return result;
    };
    try {
      await expect(
        collectLinuxExecutableEvidence(path, "listener.native_executable", {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      prototype.read = originalRead;
    }
    expect(completedReads).toBe(1);
    const linked = processDescriptorTargets();
    expect([...linked].some((target) => target === path || target === `${path} (deleted)`)).toBe(
      false,
    );
  });

  it("rejects in-place mutation across the retained descriptor", async () => {
    const directory = root();
    const path = join(directory, "native");
    executable(path, new Uint8Array(8 * 1_048_576).fill(11));
    const mutationFd = openSync(path, "r+");
    let active = true;
    let fill = 12;
    const churn = async () => {
      while (active) {
        writeSync(mutationFd, Buffer.alloc(4_096, fill), 0, 4_096, 0);
        fill = fill === 12 ? 13 : 12;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const churned = churn();
    try {
      await expect(
        collectLinuxExecutableEvidence(path, "listener.native_executable"),
      ).rejects.toMatchObject({ code: "CHANGED" });
    } finally {
      active = false;
      await churned;
      closeSync(mutationFd);
    }
  });

  it("rejects concurrent truncation and growth", async () => {
    const directory = root();
    for (const kind of ["truncate", "grow"] as const) {
      const path = join(directory, kind);
      executable(path, new Uint8Array(8 * 1_048_576).fill(21));
      const mutationFd = openSync(path, "r+");
      let active = true;
      const originalLength = 8 * 1_048_576;
      const churn = async () => {
        let alternate = false;
        while (active) {
          ftruncateSync(
            mutationFd,
            kind === "truncate"
              ? alternate
                ? originalLength
                : originalLength - 4_096
              : alternate
                ? originalLength
                : originalLength + 4_096,
          );
          alternate = !alternate;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      };
      const churned = churn();
      let failure: unknown;
      try {
        await collectLinuxExecutableEvidence(path, "listener.native_executable");
      } catch (error) {
        failure = error;
      } finally {
        active = false;
        await churned;
        closeSync(mutationFd);
      }
      expect(failure).toBeInstanceOf(LinuxExecutableCollectionError);
      expect(["TRUNCATED", "GREW", "CHANGED"]).toContain(
        (failure as LinuxExecutableCollectionError).code,
      );
    }
  });

  it("returns defensive canonical bytes and frozen parsed structures", async () => {
    const directory = root();
    const path = join(directory, "front-door");
    executable(path, Uint8Array.of(1, 2, 3, 4));
    const collected = await collectLinuxExecutableEvidence(path, "listener.front_door_executable");
    expect(Object.isFrozen(collected)).toBe(true);
    expect(Object.isFrozen(collected.manifest)).toBe(true);
    expect(Object.isFrozen(collected.manifest.chunks)).toBe(true);
    const nominalMarkers = Object.getOwnPropertySymbols(collected);
    expect(nominalMarkers).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(collected, nominalMarkers[0] as symbol)).toMatchObject({
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    expect(Object.getOwnPropertySymbols({ ...collected })).toHaveLength(0);
    const copy = collected.canonicalBytes.copyBytes();
    const originalFirst = copy[0];
    copy.fill(0);
    expect(collected.canonicalBytes.copyBytes()[0]).toBe(originalFirst);
  });
});
