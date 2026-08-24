import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const STABLE_CLAUDE_VERSION = "2.1.237 (Claude Code)";
export const STABLE_CLAUDE_PLATFORM = "linux";
export const STABLE_CLAUDE_ARCH = "arm64";
export const STABLE_CLAUDE_BINARY_BYTES = 331_864_296;
export const STABLE_CLAUDE_EXECUTABLE_SHA256 =
  "a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_BYTES = 4_096;
const EXECUTABLE_HASH_CHUNK_BYTES = 1024 * 1024;
const STABLE_CLAUDE_UID = 0;
const STABLE_CLAUDE_GID = 0;
const STABLE_CLAUDE_MODE = 0o755;

export const STABLE_CLAUDE_REQUIREMENT = `stable --rc-app requires Claude ${STABLE_CLAUDE_VERSION} on ${STABLE_CLAUDE_PLATFORM}/${STABLE_CLAUDE_ARCH}`;

export type ClaudeVersionReader = (claudeBin: string) => Promise<string>;

export function compatibilityProbeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  // Match the real launch boundary: these values belong to the wrapper and must not reach even the
  // short-lived version probe child.
  delete env.REMOTE_CLAW_SECRET_FILE;
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

function readClaudeVersion(claudeBin: string): Promise<string> {
  const env = compatibilityProbeEnv(process.env);
  return new Promise((resolve, reject) => {
    nodeExecFile(
      claudeBin,
      ["--version"],
      {
        encoding: "utf8",
        env,
        maxBuffer: VERSION_PROBE_MAX_BYTES,
        timeout: VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Claude compatibility probe failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface StableClaudeCompatibilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly readVersion?: ClaudeVersionReader;
}

export interface StableClaudeExecutableOptions extends StableClaudeCompatibilityOptions {
  /** Injectable command-search path for deterministic tests. The production default is process PATH. */
  readonly path?: string;
  /** Exact fixture identity for deterministic tests. Production callers must omit this. */
  readonly expectedExecutableIdentity?: StableClaudeExecutableIdentity;
}

export interface StableClaudeExecutableIdentity {
  readonly byteLength: number;
  readonly sha256: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

const STABLE_CLAUDE_EXECUTABLE_IDENTITY: StableClaudeExecutableIdentity = Object.freeze({
  byteLength: STABLE_CLAUDE_BINARY_BYTES,
  sha256: STABLE_CLAUDE_EXECUTABLE_SHA256,
  uid: STABLE_CLAUDE_UID,
  gid: STABLE_CLAUDE_GID,
  mode: STABLE_CLAUDE_MODE,
});

/** A held executable inode. `claudeBin` names the open descriptor, not the mutable source path. */
export interface StableClaudeExecutable {
  readonly claudeBin: string;
  release(): void;
}

/**
 * Fail closed before stable MITM startup unless this host matches the one retained compatibility
 * tuple. The error deliberately excludes the executable path, raw child output, and spawn details.
 */
export async function assertStableClaudeCompatibility(
  claudeBin: string,
  options: StableClaudeCompatibilityOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== STABLE_CLAUDE_PLATFORM || arch !== STABLE_CLAUDE_ARCH) {
    throw new Error(STABLE_CLAUDE_REQUIREMENT);
  }

  let version: string;
  try {
    version = await (options.readVersion ?? readClaudeVersion)(claudeBin);
  } catch {
    throw new Error(STABLE_CLAUDE_REQUIREMENT);
  }
  if (version.trim() !== STABLE_CLAUDE_VERSION) {
    throw new Error(STABLE_CLAUDE_REQUIREMENT);
  }
}

/**
 * Resolve, open, and probe the stable Claude executable once, then retain that exact inode until the
 * caller has finished spawning/running it. A package upgrade or symlink retarget after this function
 * returns cannot substitute different bytes: both the compatibility child and the eventual Claude
 * child execute through `/proc/<this-pid>/fd/<fd>` while this process holds the descriptor open.
 *
 * Stable Claude is Linux/arm64-only, so the procfs binding is part of the supported host contract.
 * Errors deliberately collapse to the same path/output-free compatibility message.
 */
export async function acquireStableClaudeExecutable(
  claudeBin: string,
  options: StableClaudeExecutableOptions = {},
): Promise<StableClaudeExecutable> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== STABLE_CLAUDE_PLATFORM || arch !== STABLE_CLAUDE_ARCH) {
    throw new Error(STABLE_CLAUDE_REQUIREMENT);
  }

  let descriptor: number | undefined;
  try {
    descriptor = openExecutable(claudeBin, options.path ?? process.env.PATH);
    assertExecutableIdentity(
      descriptor,
      options.expectedExecutableIdentity ?? STABLE_CLAUDE_EXECUTABLE_IDENTITY,
    );
    const pinnedPath = `/proc/${process.pid}/fd/${descriptor}`;
    await assertStableClaudeCompatibility(pinnedPath, {
      platform,
      arch,
      ...(options.readVersion !== undefined ? { readVersion: options.readVersion } : {}),
    });
    let released = false;
    return {
      claudeBin: pinnedPath,
      release() {
        if (released) return;
        released = true;
        closeSync(descriptor as number);
      },
    };
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the single bounded compatibility error below.
      }
    }
    throw new Error(STABLE_CLAUDE_REQUIREMENT);
  }
}

function assertExecutableIdentity(
  descriptor: number,
  expected: StableClaudeExecutableIdentity,
): void {
  const before = fstatSync(descriptor);
  if (
    !before.isFile() ||
    before.size !== expected.byteLength ||
    before.uid !== expected.uid ||
    before.gid !== expected.gid ||
    (before.mode & 0o7777) !== expected.mode
  ) {
    throw new Error("unexpected executable identity");
  }

  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(EXECUTABLE_HASH_CHUNK_BYTES);
  let offset = 0;
  try {
    while (offset < expected.byteLength) {
      const wanted = Math.min(chunk.byteLength, expected.byteLength - offset);
      const count = readSync(descriptor, chunk, 0, wanted, offset);
      if (count <= 0) throw new Error("short executable read");
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    if (readSync(descriptor, chunk, 0, 1, offset) !== 0) {
      throw new Error("executable grew during verification");
    }
  } finally {
    chunk.fill(0);
  }

  if (hash.digest("hex") !== expected.sha256) {
    throw new Error("unexpected executable digest");
  }

  const after = fstatSync(descriptor);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.uid !== before.uid ||
    after.gid !== before.gid ||
    after.mode !== before.mode
  ) {
    throw new Error("executable changed during verification");
  }
}

function openExecutable(command: string, pathValue: string | undefined): number {
  if (command.length === 0 || command.includes("\0")) throw new Error("invalid executable");
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(command)]
    : (pathValue ?? "/usr/bin:/bin")
        .split(delimiter)
        .map((directory) => join(directory === "" ? "." : directory, command));

  for (const candidate of candidates) {
    let descriptor: number | undefined;
    try {
      // Resolve an intended launcher symlink first, then refuse a symlink inserted between resolution
      // and open. Whatever regular inode wins the open is the one checked and eventually executed.
      const target = realpathSync(candidate);
      descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("not executable");
      return descriptor;
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Try the next PATH candidate.
        }
      }
    }
  }
  throw new Error("executable unavailable");
}
