import { execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { parseA1CanonicalId, parseA1SafeId } from "../state/ids.js";
import {
  encodeNativeWorkspaceBindingInput,
  NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
  NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID,
  NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID,
} from "../state/native-binding-authority-evidence.js";
import { verifyCanonicalWorkspaceEvidenceBundle } from "../state/native-binding-authority-workspace-evidence.js";
import {
  type CollectLinuxWorkspaceEvidenceInput,
  collectLinuxWorkspaceEvidence,
} from "./linux-workspace-collector.js";

type FsModule = typeof import("node:fs");
type UnknownFunction = (...args: readonly unknown[]) => unknown;

const require = createRequire(import.meta.url);
const mutableFs = require("node:fs") as Record<string, unknown>;
const originalFs = require("node:fs") as FsModule;
const realFs = Object.freeze({
  chmodSync: originalFs.chmodSync,
  closeSync: originalFs.closeSync,
  constants: originalFs.constants,
  fstatSync: originalFs.fstatSync,
  mkdirSync: originalFs.mkdirSync,
  mkdtempSync: originalFs.mkdtempSync,
  openSync: originalFs.openSync,
  readlinkSync: originalFs.readlinkSync,
  readFileSync: originalFs.readFileSync,
  readSync: originalFs.readSync,
  readdirSync: originalFs.readdirSync,
  renameSync: originalFs.renameSync,
  rmSync: originalFs.rmSync,
  statfsSync: originalFs.statfsSync,
  statSync: originalFs.statSync,
  symlinkSync: originalFs.symlinkSync,
  writeFileSync: originalFs.writeFileSync,
});
const originals = new Map<string, unknown>();
const roots: string[] = [];

const runtimeId = parseA1CanonicalId(
  "nativeRuntime",
  `rcrt_${Buffer.alloc(32, 0x31).toString("base64url")}`,
);

function patchFs(name: keyof FsModule, replacement: UnknownFunction): void {
  if (!originals.has(name)) originals.set(name, mutableFs[name]);
  mutableFs[name] = replacement;
  syncBuiltinESMExports();
}

function restoreFs(): void {
  for (const [name, value] of originals) mutableFs[name] = value;
  originals.clear();
  syncBuiltinESMExports();
}

function call<T>(fn: unknown, args: readonly unknown[]): T {
  return Reflect.apply(fn as UnknownFunction, undefined, args) as T;
}

function root(): string {
  const value = realFs.mkdtempSync(join(tmpdir(), "remote-claw-workspace-evidence-"));
  roots.push(value);
  return value;
}

function directories(...paths: readonly string[]): void {
  for (const path of paths) realFs.mkdirSync(path, { recursive: true });
}

function input(
  allowedRoot: string,
  canonicalDirectory: string,
): CollectLinuxWorkspaceEvidenceInput {
  return { runtimeId, nativeIncarnation: 3, allowedRoot, canonicalDirectory };
}

function fixture(): Readonly<{ base: string; allowedRoot: string; target: string }> {
  const base = root();
  const allowedRoot = join(base, "allowed-marker");
  const target = join(allowedRoot, "target-marker");
  directories(target);
  return Object.freeze({ base, allowedRoot, target });
}

function descriptorTargets(): ReadonlySet<string> {
  const result = new Set<string>();
  for (const entry of realFs.readdirSync("/proc/self/fd")) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(entry)) continue;
    try {
      result.add(realFs.readlinkSync(`/proc/self/fd/${entry}`));
    } catch {
      // Descriptor raced closed while enumerating the diagnostic view.
    }
  }
  return result;
}

function descriptorSnapshot(): readonly string[] {
  const result: string[] = [];
  for (const entry of realFs.readdirSync("/proc/self/fd")) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(entry)) continue;
    try {
      const target = realFs.readlinkSync(`/proc/self/fd/${entry}`);
      const stat = realFs.fstatSync(Number(entry), { bigint: true });
      result.push(`${entry}:${stat.dev}:${stat.ino}:${target}`);
    } catch {
      // The enumeration descriptor itself is allowed to disappear before inspection.
    }
  }
  return Object.freeze(result.sort());
}

function expectDescriptorSnapshot(before: readonly string[]): void {
  expect(descriptorSnapshot()).toEqual(before);
}

function expectNoFixtureDescriptor(path: string): void {
  expect(
    [...descriptorTargets()].some((target) => target === path || target.startsWith(`${path}/`)),
  ).toBe(false);
}

function installOneFdText(pathFragment: string, text: Buffer): void {
  let selectedFd: number | undefined;
  let selectedOffset = 0;
  let selectedOpen = true;
  patchFs("openSync", (...args) => {
    const fd = call<number>(realFs.openSync, args);
    if (selectedFd === undefined && String(args[0]).includes(pathFragment)) selectedFd = fd;
    return fd;
  });
  patchFs("readSync", (...args) => {
    if (selectedOpen && args[0] === selectedFd) {
      const buffer = args[1] as Buffer;
      const offset = args[2] as number;
      const length = args[3] as number;
      const count = Math.min(length, text.byteLength - selectedOffset);
      if (count <= 0) return 0;
      text.copy(buffer, offset, selectedOffset, selectedOffset + count);
      selectedOffset += count;
      return count;
    }
    return call<number>(realFs.readSync, args);
  });
  patchFs("closeSync", (...args) => {
    if (args[0] === selectedFd) selectedOpen = false;
    return call<void>(realFs.closeSync, args);
  });
}

function installBootTexts(texts: readonly Buffer[]): Readonly<{ opened: () => number }> {
  const bootFds = new Map<number, { readonly bytes: Buffer; offset: number }>();
  let opened = 0;
  patchFs("openSync", (...args) => {
    const fd = call<number>(realFs.openSync, args);
    if (args[0] === "/proc/sys/kernel/random/boot_id") {
      const bytes = texts[Math.min(opened, texts.length - 1)];
      opened++;
      if (bytes !== undefined) bootFds.set(fd, { bytes, offset: 0 });
    }
    return fd;
  });
  patchFs("readSync", (...args) => {
    const state = bootFds.get(args[0] as number);
    if (state === undefined) return call<number>(realFs.readSync, args);
    const buffer = args[1] as Buffer;
    const outputOffset = args[2] as number;
    const length = args[3] as number;
    const count = Math.min(length, state.bytes.byteLength - state.offset);
    if (count <= 0) return 0;
    state.bytes.copy(buffer, outputOffset, state.offset, state.offset + count);
    state.offset += count;
    return count;
  });
  return Object.freeze({ opened: () => opened });
}

function changedBigIntStats(
  value: ReturnType<FsModule["fstatSync"]> | NonNullable<ReturnType<FsModule["statSync"]>>,
  changes: Readonly<Record<string, bigint>>,
): object {
  return Object.assign(Object.create(Object.getPrototypeOf(value)) as object, value, changes);
}

afterEach(() => {
  restoreFs();
  for (const path of roots.splice(0)) realFs.rmSync(path, { recursive: true, force: true });
});

describe.sequential("Linux workspace evidence collector", () => {
  it("exposes one exact input, no AbortSignal, and no promise-filesystem observation surface", () => {
    expectTypeOf<Parameters<typeof collectLinuxWorkspaceEvidence>>().toEqualTypeOf<
      [CollectLinuxWorkspaceEvidenceInput]
    >();
    const source = realFs.readFileSync(
      fileURLToPath(new URL("./linux-workspace-collector.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("node:fs/promises");
    expect(source).not.toContain("AbortSignal");
    expect(source).not.toContain("setImmediate");
  });

  it("rejects hostile input and target escape before the first filesystem operation", async () => {
    let opens = 0;
    patchFs("openSync", (...args) => {
      opens++;
      return call<number>(realFs.openSync, args);
    });

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "runtimeId", { get: () => runtimeId });
    Object.defineProperties(accessor, {
      nativeIncarnation: { value: 3 },
      allowedRoot: { value: "/safe" },
      canonicalDirectory: { value: "/safe" },
    });
    await expect(
      collectLinuxWorkspaceEvidence(accessor as unknown as CollectLinuxWorkspaceEvidenceInput),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      collectLinuxWorkspaceEvidence(input("/safe/root", "/safe/root-prefix")),
    ).rejects.toMatchObject({ code: "TARGET_OUTSIDE_ALLOWED_ROOT" });
    await expect(
      collectLinuxWorkspaceEvidence({
        ...input("/", "/"),
        nativeIncarnation: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(opens).toBe(0);
  });

  it("collects the exact frozen four-leaf DAG, recreates the E1a parent, and leaks no descriptor", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    const collected = await collectLinuxWorkspaceEvidence(
      input(selected.allowedRoot, selected.target),
    );

    expect(Reflect.ownKeys(collected)).toEqual([
      "mountNamespace",
      "canonicalDirectory",
      "filesystemIdentity",
      "allowedRoot",
    ]);
    expect(Object.isFrozen(collected)).toBe(true);
    for (const artifact of Object.values(collected)) {
      expect(Object.isFrozen(artifact)).toBe(true);
      expect(Object.isFrozen(artifact.evidence)).toBe(true);
      expect(Object.isFrozen(artifact.commitment)).toBe(true);
    }
    expect(collected.allowedRoot.evidence.allowedRootEntries).toHaveLength(
      collected.allowedRoot.evidence.allowedRootEntryCount,
    );
    expect(collected.allowedRoot.evidence.targetEntries).toHaveLength(
      collected.allowedRoot.evidence.targetEntryCount,
    );
    const targetFinal = collected.allowedRoot.evidence.targetEntries.at(-1);
    expect(targetFinal).toMatchObject({
      directoryDevice: collected.filesystemIdentity.evidence.directoryDevice,
      directoryInode: collected.filesystemIdentity.evidence.directoryInode,
      mountId: collected.filesystemIdentity.evidence.mountId,
      filesystemMagic: collected.filesystemIdentity.evidence.filesystemMagic,
    });

    const workspaceParentBytes = encodeNativeWorkspaceBindingInput({
      schemaId: NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID,
      schemaVersion: 1,
      nativeWorkspaceBindingId: parseA1CanonicalId(
        "nativeWorkspaceBinding",
        `nwb_${Buffer.alloc(16, 0x41).toString("base64url")}`,
      ),
      runtimeId,
      nativeIncarnation: 3,
      projectId: parseA1CanonicalId(
        "project",
        `rcpj_${Buffer.alloc(16, 0x42).toString("base64url")}`,
      ),
      nativeWorkspaceId: parseA1SafeId("workspace-native-id"),
      directoryNormalizationSchemaId: NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
      filesystemIdentitySchemaId: NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID,
      workspaceGeneration: 1,
      artifacts: [
        collected.canonicalDirectory.commitment,
        collected.filesystemIdentity.commitment,
        collected.allowedRoot.commitment,
        collected.mountNamespace.commitment,
      ],
    });
    await expect(
      verifyCanonicalWorkspaceEvidenceBundle({
        mountNamespaceBytes: collected.mountNamespace.canonicalBytes.copyBytes(),
        canonicalDirectoryBytes: collected.canonicalDirectory.canonicalBytes.copyBytes(),
        filesystemIdentityBytes: collected.filesystemIdentity.canonicalBytes.copyBytes(),
        allowedRootBytes: collected.allowedRoot.canonicalBytes.copyBytes(),
        workspaceParentBytes,
      }),
    ).resolves.toMatchObject({
      workspaceSlot: { kind: "native_workspace_id", value: "workspace-native-id" },
    });
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it("accepts root and inclusive allowed-root equality", async () => {
    const collected = await collectLinuxWorkspaceEvidence(input("/", "/"));
    expect(collected.allowedRoot.evidence.allowedRootEntries).toHaveLength(1);
    expect(collected.allowedRoot.evidence.targetEntries).toEqual(
      collected.allowedRoot.evidence.allowedRootEntries,
    );
  });

  it("canonicalizes exact 36-byte and 36-byte-plus-LF boot files to identical M bytes", async () => {
    const selected = fixture();
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const descriptorsBefore = descriptorSnapshot();
    let installed = installBootTexts([Buffer.from(uuid), Buffer.from(uuid)]);
    const withoutLf = await collectLinuxWorkspaceEvidence(
      input(selected.allowedRoot, selected.target),
    );
    expect(installed.opened()).toBe(2);
    restoreFs();
    installed = installBootTexts([Buffer.from(`${uuid}\n`), Buffer.from(`${uuid}\n`)]);
    const withLf = await collectLinuxWorkspaceEvidence(
      input(selected.allowedRoot, selected.target),
    );
    expect(installed.opened()).toBe(2);
    expect(withLf.mountNamespace.canonicalBytes.copyBytes()).toEqual(
      withoutLf.mountNamespace.canonicalBytes.copyBytes(),
    );
    expect(withLf.mountNamespace.evidence.bootId).toBe(uuid);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it.each([
    ["uppercase", Buffer.from("12345678-1234-1234-1234-123456789ABc\n")],
    ["extra whitespace", Buffer.from("12345678-1234-1234-1234-123456789abc \n")],
    ["beyond EOF cap", Buffer.from("12345678-1234-1234-1234-123456789abc\nX")],
  ])("rejects a %s boot file with full descriptor cleanup", async (_name, bytes) => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    installBootTexts([bytes]);
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "BOOT_ID_INVALID" });
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it.each(
    (["symlink", "regular_file"] as const).flatMap((kind) =>
      [0, 1, 2, 3].map((position) => [kind, position] as const),
    ),
  )("refuses a %s at controlled selector component %i", async (kind, position) => {
    const base = root();
    const components = ["selector-a", "selector-b", "selector-c", "selector-d"] as const;
    const allowedRoot = join(base, components[0], components[1]);
    const target = join(allowedRoot, components[2], components[3]);
    directories(target);
    const selectedPath = join(base, ...components.slice(0, position + 1));
    const movedPath = `${selectedPath}-real`;
    realFs.renameSync(selectedPath, movedPath);
    if (kind === "symlink") {
      realFs.symlinkSync(movedPath, selectedPath, "dir");
    } else {
      realFs.rmSync(movedPath, { recursive: true, force: true });
      realFs.writeFileSync(selectedPath, "not a directory");
    }
    const descriptorsBefore = descriptorSnapshot();
    await expect(collectLinuxWorkspaceEvidence(input(allowedRoot, target))).rejects.toMatchObject({
      code: "PATH_COMPONENT_REFUSED",
    });
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(base);
  });

  it("detects replacement between the independent retained allowed-root and target walks", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    const oldAllowedRoot = join(selected.base, "old-allowed-root");
    let allowedRootOpens = 0;
    patchFs("openSync", (...args) => {
      const path = String(args[0]);
      if (path.endsWith("/allowed-marker")) {
        allowedRootOpens++;
        if (allowedRootOpens === 2) {
          realFs.renameSync(selected.allowedRoot, oldAllowedRoot);
          directories(selected.target);
        }
      }
      return call<number>(realFs.openSync, args);
    });

    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "CHANGED" });
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it.each([
    0, 1,
  ])("detects target-walk replacement at overlapping controlled component %i", async (position) => {
    const base = root();
    const components = ["overlap-a", "overlap-b"] as const;
    const allowedRoot = join(base, ...components);
    const target = join(allowedRoot, "target");
    directories(target);
    const descriptorsBefore = descriptorSnapshot();
    let opens = 0;
    const component = components[position];
    if (component === undefined) throw new Error("missing overlap component");
    const selectedPath = join(base, ...components.slice(0, position + 1));
    const movedPath = `${selectedPath}-old`;
    patchFs("openSync", (...args) => {
      if (String(args[0]).endsWith(`/${component}`)) {
        opens++;
        if (opens === 2) {
          realFs.renameSync(selectedPath, movedPath);
          directories(target);
        }
      }
      return call<number>(realFs.openSync, args);
    });
    await expect(collectLinuxWorkspaceEvidence(input(allowedRoot, target))).rejects.toMatchObject({
      code: "CHANGED",
    });
    expect(opens).toBe(2);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it.each([
    "allowed_root",
    "target",
  ] as const)("detects a %s complete-fact mutation between the two retained sweeps", async (selector) => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    let selectedFd: number | undefined;
    let selectedStats = 0;
    patchFs("openSync", (...args) => {
      const fd = call<number>(realFs.openSync, args);
      const suffix = selector === "allowed_root" ? "/allowed-marker" : "/target-marker";
      if (selectedFd === undefined && String(args[0]).endsWith(suffix)) selectedFd = fd;
      return fd;
    });
    patchFs("fstatSync", (...args) => {
      if (args[0] === selectedFd) {
        selectedStats++;
        if (selectedStats === 3) {
          realFs.chmodSync(
            selector === "allowed_root" ? selected.allowedRoot : selected.target,
            0o700,
          );
        }
      }
      return call<ReturnType<FsModule["fstatSync"]>>(realFs.fstatSync, args);
    });

    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "CHANGED" });
    expect(selectedStats).toBe(3);
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it("detects replacement during the fresh absolute target rewalk", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    const oldTarget = join(selected.allowedRoot, "old-target");
    let targetOpens = 0;
    patchFs("openSync", (...args) => {
      if (String(args[0]).endsWith("/target-marker")) {
        targetOpens++;
        if (targetOpens === 2) {
          realFs.renameSync(selected.target, oldTarget);
          directories(selected.target);
        }
      }
      return call<number>(realFs.openSync, args);
    });

    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "CHANGED" });
    expect(targetOpens).toBe(2);
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it.each([
    ["before_allowed_fresh_walk", 3],
    ["between_allowed_and_target_fresh_walks", 4],
  ] as const)("detects an overlapping-prefix replacement %s", async (_boundary, triggerOpen) => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    const oldAllowedRoot = join(selected.base, `old-allowed-${triggerOpen}`);
    let allowedRootOpens = 0;
    patchFs("openSync", (...args) => {
      if (String(args[0]).endsWith("/allowed-marker")) {
        allowedRootOpens++;
        if (allowedRootOpens === triggerOpen) {
          realFs.renameSync(selected.allowedRoot, oldAllowedRoot);
          directories(selected.target);
        }
      }
      return call<number>(realFs.openSync, args);
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "CHANGED" });
    expect(allowedRootOpens).toBe(triggerOpen);
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it.each([
    ["missing", Buffer.from("pos:\t0\n")],
    ["duplicate", Buffer.from("mnt_id:\t1\nmnt_id:\t1\n")],
    ["leading-zero", Buffer.from("mnt_id:\t01\n")],
    ["zero", Buffer.from("mnt_id:\t0\n")],
    ["noncanonical separator", Buffer.from("mnt_id: 1\n")],
    ["u64 overflow", Buffer.from("mnt_id:\t18446744073709551616\n")],
    ["oversized", Buffer.alloc(16_385, 0x78)],
  ])("rejects %s fdinfo without leaking the sampled descriptor", async (_name, text) => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    installOneFdText("/proc/self/fdinfo/", text);
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "FDINFO_INVALID" });
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it("rejects an invalid nsfs operational link", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    let changed = false;
    patchFs("readlinkSync", (...args) => {
      const value = call<string>(realFs.readlinkSync, args);
      if (!changed && value.startsWith("mnt:[")) {
        changed = true;
        return "mnt:[1]";
      }
      return value;
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "NAMESPACE_INVALID" });
    expect(changed).toBe(true);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it.each([
    "procfs_magic",
    "nsfs_magic",
    "linked_stat_identity",
  ] as const)("rejects invalid namespace prerequisite %s", async (failure) => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    if (failure === "procfs_magic") {
      let changed = false;
      patchFs("statfsSync", (...args) => {
        const actual = call<ReturnType<FsModule["statfsSync"]>>(realFs.statfsSync, args);
        if (!changed && args[0] === "/proc/thread-self") {
          changed = true;
          return { ...actual, type: 1n };
        }
        return actual;
      });
    } else if (failure === "nsfs_magic") {
      let changed = false;
      patchFs("statfsSync", (...args) => {
        const actual = call<ReturnType<FsModule["statfsSync"]>>(realFs.statfsSync, args);
        if (!changed && BigInt(actual.type) === 0x6e736673n) {
          changed = true;
          return { ...actual, type: 1n };
        }
        return actual;
      });
    } else {
      let changed = false;
      patchFs("statSync", (...args) => {
        const actual = call<NonNullable<ReturnType<FsModule["statSync"]>>>(realFs.statSync, args);
        if (!changed) {
          try {
            if (realFs.readlinkSync(String(args[0])).startsWith("mnt:[")) {
              changed = true;
              return changedBigIntStats(actual, { ino: BigInt(actual.ino) + 1n });
            }
          } catch {
            // Non-namespace descriptor.
          }
        }
        return actual;
      });
    }
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({
      code: failure === "procfs_magic" ? "PROCFS_INVALID" : "NAMESPACE_INVALID",
    });
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it.each([
    "/proc/thread-self",
    "/proc/self/fd",
    "/proc/self/fdinfo",
  ])("rejects wrong procfs magic for trusted path %s before acquisition", async (procPath) => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    patchFs("statfsSync", (...args) => {
      const actual = call<ReturnType<FsModule["statfsSync"]>>(realFs.statfsSync, args);
      return args[0] === procPath ? { ...actual, type: 1n } : actual;
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "PROCFS_INVALID" });
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it("fully validates but rejects an independently mismatched second namespace identity", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    const namespaceFds: number[] = [];
    patchFs("openSync", (...args) => {
      const fd = call<number>(realFs.openSync, args);
      if (args[0] === "/proc/thread-self/ns/mnt") namespaceFds.push(fd);
      return fd;
    });
    patchFs("fstatSync", (...args) => {
      const actual = call<ReturnType<FsModule["fstatSync"]>>(realFs.fstatSync, args);
      if (args[0] === namespaceFds[1]) {
        return changedBigIntStats(actual, { ino: BigInt(actual.ino) + 1n });
      }
      return actual;
    });
    patchFs("statSync", (...args) => {
      const actual = call<NonNullable<ReturnType<FsModule["statSync"]>>>(realFs.statSync, args);
      if (String(args[0]) === `/proc/self/fd/${namespaceFds[1]}`) {
        return changedBigIntStats(actual, { ino: BigInt(actual.ino) + 1n });
      }
      return actual;
    });
    patchFs("readlinkSync", (...args) => {
      const actual = call<string>(realFs.readlinkSync, args);
      if (String(args[0]) === `/proc/self/fd/${namespaceFds[1]}`) {
        const inode = /^mnt:\[([0-9]+)\]$/.exec(actual)?.[1];
        if (inode === undefined) return actual;
        return `mnt:[${(BigInt(inode) + 1n).toString()}]`;
      }
      return actual;
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "CHANGED" });
    expect(namespaceFds).toHaveLength(2);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it("rejects fstat-versus-proc descriptor identity mismatch for a retained directory", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    let changed = false;
    patchFs("statSync", (...args) => {
      const actual = call<NonNullable<ReturnType<FsModule["statSync"]>>>(realFs.statSync, args);
      if (!changed && typeof actual.isDirectory === "function" && actual.isDirectory()) {
        changed = true;
        return changedBigIntStats(actual, { ino: BigInt(actual.ino) + 1n });
      }
      return actual;
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "FD_IDENTITY_MISMATCH" });
    expect(changed).toBe(true);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it("rejects a directory unlinked immediately after no-follow open", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    let removed = false;
    patchFs("openSync", (...args) => {
      const fd = call<number>(realFs.openSync, args);
      if (!removed && String(args[0]).endsWith("/target-marker")) {
        removed = true;
        realFs.rmSync(selected.target, { recursive: true });
      }
      return fd;
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "UNLINKED" });
    expect(removed).toBe(true);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it("closes every previously acquired descriptor when a component open fails with EMFILE", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    let injected = false;
    patchFs("openSync", (...args) => {
      if (!injected && String(args[0]).endsWith("/allowed-marker")) {
        injected = true;
        throw Object.assign(new Error("injected descriptor exhaustion"), { code: "EMFILE" });
      }
      return call<number>(realFs.openSync, args);
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "PATH_OPEN_FAILED" });
    expect(injected).toBe(true);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it("rejects a valid but different second boot identity", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    const texts = [
      Buffer.from("11111111-1111-1111-1111-111111111111\n"),
      Buffer.from("22222222-2222-2222-2222-222222222222\n"),
    ];
    const installed = installBootTexts(texts);
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "CHANGED" });
    expect(installed.opened()).toBe(2);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it("normalizes a signed high-bit statfs type as an unsigned 32-bit filesystem magic", async () => {
    const selected = fixture();
    patchFs("statfsSync", (...args) => {
      const actual = call<ReturnType<FsModule["statfsSync"]>>(realFs.statfsSync, args);
      const numeric = BigInt(actual.type);
      if (String(args[0]).startsWith("/proc/self/fd/") && numeric !== 0x6e736673n) {
        return { ...actual, type: -2_147_483_648n };
      }
      return actual;
    });
    const collected = await collectLinuxWorkspaceEvidence(
      input(selected.allowedRoot, selected.target),
    );
    expect(collected.filesystemIdentity.evidence.filesystemMagic).toBe("2147483648");
    expect(
      collected.allowedRoot.evidence.targetEntries.every(
        (entry) => entry.filesystemMagic === "2147483648",
      ),
    ).toBe(true);
  });

  it("never retries a close that released its numeric FD before throwing", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    let foreignFd: number | undefined;
    let injected = false;
    patchFs("closeSync", (...args) => {
      call<void>(realFs.closeSync, args);
      if (!injected) {
        injected = true;
        foreignFd = realFs.openSync("/dev/null", realFs.constants.O_RDONLY);
        throw new Error("injected close report after release");
      }
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "CLOSE_FAILED" });
    expect(foreignFd).toBeDefined();
    expect(() => realFs.fstatSync(foreignFd as number)).not.toThrow();
    realFs.closeSync(foreignFd as number);
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it("closes every still-owned descriptor in exact reverse acquisition order", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    const acquisitions: Array<{ readonly generation: number; open: boolean }> = [];
    const activeByFd = new Map<number, (typeof acquisitions)[number]>();
    const cleanupActual: number[] = [];
    let cleanupExpected: number[] | undefined;
    let nextGeneration = 1;
    let bootOpens = 0;
    patchFs("openSync", (...args) => {
      const fd = call<number>(realFs.openSync, args);
      expect(activeByFd.has(fd)).toBe(false);
      const owner = { generation: nextGeneration++, open: true };
      acquisitions.push(owner);
      activeByFd.set(fd, owner);
      if (args[0] === "/proc/sys/kernel/random/boot_id" && ++bootOpens === 2) {
        cleanupExpected = acquisitions
          .filter((entry) => entry.open)
          .map((entry) => entry.generation)
          .reverse();
      }
      return fd;
    });
    patchFs("closeSync", (...args) => {
      const fd = args[0] as number;
      const owner = activeByFd.get(fd);
      expect(owner).toBeDefined();
      if (cleanupExpected !== undefined) cleanupActual.push(owner?.generation ?? -1);
      if (owner !== undefined) owner.open = false;
      activeByFd.delete(fd);
      return call<void>(realFs.closeSync, args);
    });
    await collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target));
    expect(cleanupExpected).toBeDefined();
    expect(cleanupActual).toEqual(cleanupExpected);
    expect(activeByFd.size).toBe(0);
    expect(acquisitions.length).toBeGreaterThan(cleanupActual.length);
    expectDescriptorSnapshot(descriptorsBefore);
  });

  it("fails closed without leaks at every descriptor-close position", async () => {
    const baseline = fixture();
    let successfulCloseCount = 0;
    patchFs("closeSync", (...args) => {
      successfulCloseCount++;
      return call<void>(realFs.closeSync, args);
    });
    await collectLinuxWorkspaceEvidence(input(baseline.allowedRoot, baseline.target));
    restoreFs();
    expect(successfulCloseCount).toBeGreaterThan(10);

    for (let failurePosition = 1; failurePosition <= successfulCloseCount; failurePosition++) {
      const selected = fixture();
      const descriptorsBefore = descriptorSnapshot();
      let closePosition = 0;
      patchFs("closeSync", (...args) => {
        closePosition++;
        call<void>(realFs.closeSync, args);
        if (closePosition === failurePosition) {
          throw new Error("injected close report after release");
        }
      });
      await expect(
        collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
        `close position ${failurePosition}/${successfulCloseCount}`,
      ).rejects.toMatchObject({ code: "CLOSE_FAILED" });
      expect(closePosition).toBeGreaterThanOrEqual(failurePosition);
      expectDescriptorSnapshot(descriptorsBefore);
      restoreFs();
    }
  });

  it("keeps the observation error primary while attempting every later cleanup close", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    let primaryTriggered = false;
    let closeFailures = 0;
    patchFs("readlinkSync", (...args) => {
      const value = call<string>(realFs.readlinkSync, args);
      if (!primaryTriggered && value.startsWith("mnt:[")) {
        primaryTriggered = true;
        return "mnt:[1]";
      }
      return value;
    });
    patchFs("closeSync", (...args) => {
      call<void>(realFs.closeSync, args);
      if (primaryTriggered) {
        closeFailures++;
        throw new Error("injected cleanup close failure");
      }
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "NAMESPACE_INVALID" });
    expect(closeFailures).toBeGreaterThan(1);
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it("reports the first cleanup close failure only after a successful observation", async () => {
    const selected = fixture();
    const descriptorsBefore = descriptorSnapshot();
    let bootOpens = 0;
    let cleanupStarted = false;
    let cleanupCloses = 0;
    patchFs("openSync", (...args) => {
      const fd = call<number>(realFs.openSync, args);
      if (args[0] === "/proc/sys/kernel/random/boot_id") {
        bootOpens++;
        if (bootOpens === 2) cleanupStarted = true;
      }
      return fd;
    });
    patchFs("closeSync", (...args) => {
      call<void>(realFs.closeSync, args);
      if (cleanupStarted) {
        cleanupCloses++;
        if (cleanupCloses === 1) throw new Error("first cleanup close failure");
      }
    });
    await expect(
      collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target)),
    ).rejects.toMatchObject({ code: "CLOSE_FAILED" });
    expect(cleanupCloses).toBeGreaterThan(1);
    expectDescriptorSnapshot(descriptorsBefore);
    expectNoFixtureDescriptor(selected.base);
  });

  it("performs no filesystem operation after the synchronous phase returns", async () => {
    const selected = fixture();
    let calls = 0;
    for (const name of [
      "openSync",
      "closeSync",
      "fstatSync",
      "statSync",
      "statfsSync",
      "readSync",
      "readlinkSync",
    ] as const) {
      const original = realFs[name] as unknown as UnknownFunction;
      patchFs(name, (...args) => {
        calls++;
        return call<unknown>(original, args);
      });
    }
    const pending = collectLinuxWorkspaceEvidence(input(selected.allowedRoot, selected.target));
    const callsAtFirstAwait = calls;
    await pending;
    expect(calls).toBe(callsAtFirstAwait);
    expect(callsAtFirstAwait).toBeGreaterThan(0);
  });

  it("hard-proves a real unshared mount namespace, inclusive bind root, and nested-mount refusal", () => {
    if (process.platform !== "linux") throw new Error("E1b2 mount proof requires Linux");
    const packageRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const repositoryRoot = dirname(dirname(packageRoot));
    const tsx = resolve(packageRoot, "node_modules/.bin/tsx");
    const collectorUrl = pathToFileURL(
      resolve(packageRoot, "src/host/native/linux-workspace-collector.ts"),
    ).href;
    const parentNamespace = realFs.readlinkSync("/proc/thread-self/ns/mnt");
    const script = `
(async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { collectLinuxWorkspaceEvidence, LinuxWorkspaceCollectionError } = await import(${JSON.stringify(
    collectorUrl,
  )});
  const childNamespace = fs.readlinkSync("/proc/thread-self/ns/mnt");
  if (childNamespace === process.env.RC_E1B2_PARENT_MNT_NS) throw new Error("mount namespace did not change");
  execFileSync("mount", ["--make-rprivate", "/"]);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "remote-claw-e1b2-unshare-"));
  const source = path.join(base, "source");
  const workspace = path.join(base, "workspace");
  const nestedSource = path.join(base, "nested-source");
  const nestedTarget = path.join(workspace, "sub", "nested");
  fs.mkdirSync(path.join(source, "sub", "nested"), { recursive: true });
  fs.mkdirSync(workspace);
  fs.mkdirSync(nestedSource);
  let workspaceMounted = false;
  let nestedMounted = false;
  try {
    execFileSync("mount", ["--bind", source, workspace]);
    workspaceMounted = true;
    const runtimeId = "rcrt_" + Buffer.alloc(32, 0x53).toString("base64url");
    const accepted = await collectLinuxWorkspaceEvidence({
      runtimeId,
      nativeIncarnation: 1,
      allowedRoot: workspace,
      canonicalDirectory: path.join(workspace, "sub"),
    });
    const allowedMount = accepted.allowedRoot.evidence.allowedRootEntries.at(-1)?.mountId;
    const targetMount = accepted.allowedRoot.evidence.targetEntries.at(-1)?.mountId;
    if (allowedMount === undefined || targetMount !== allowedMount) throw new Error("bind-root suffix was not retained");
    execFileSync("mount", ["--bind", nestedSource, nestedTarget]);
    nestedMounted = true;
    let rejected = false;
    try {
      await collectLinuxWorkspaceEvidence({
        runtimeId,
        nativeIncarnation: 1,
        allowedRoot: workspace,
        canonicalDirectory: nestedTarget,
      });
    } catch (error) {
      rejected = LinuxWorkspaceCollectionError.is(error) && error.code === "MOUNT_CROSSING";
    }
    if (!rejected) throw new Error("nested bind mount was not rejected");
  } finally {
    if (nestedMounted) execFileSync("umount", [nestedTarget]);
    if (workspaceMounted) execFileSync("umount", [workspace]);
    fs.rmSync(base, { recursive: true, force: true });
  }
  process.stdout.write("E1B2_UNSHARE_PROOF_OK\\n");
})().catch((error) => { console.error(error); process.exitCode = 1; });`;
    const unshareArgs = ["-Ur", "-m", "--", tsx, "--eval", script];
    const environment = {
      ...process.env,
      RC_E1B2_PARENT_MNT_NS: parentNamespace,
    };
    const output = execFileSync("unshare", unshareArgs, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      timeout: 60_000,
    });
    expect(output).toContain("E1B2_UNSHARE_PROOF_OK");
  }, 90_000);
});
