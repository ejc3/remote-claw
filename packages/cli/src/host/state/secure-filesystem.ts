import type { BigIntStats } from "node:fs";
import {
  closeSync,
  constants as FS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  statfsSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, normalize, parse, relative, sep } from "node:path";
import { HOST_STATE_DATABASE_BASENAME } from "./path.js";

export const HOST_STATE_LOCAL_FILESYSTEM_POLICY_VERSION = 1;

export interface HostStateFilesystemClassification {
  readonly allowed: boolean;
  readonly name: string;
  readonly policyVersion: typeof HOST_STATE_LOCAL_FILESYSTEM_POLICY_VERSION;
}

const ALLOWED_LOCAL_FILESYSTEMS = new Map<bigint, string>([
  [0xef53n, "ext"],
  [0x58465342n, "xfs"],
  [0x9123683en, "btrfs"],
  [0xf2f52010n, "f2fs"],
  [0x2fc12fc1n, "zfs"],
]);

const DENIED_FILESYSTEM_NAMES = new Map<bigint, string>([
  [0x01021994n, "tmpfs"],
  [0x6969n, "nfs"],
  [0xff534d42n, "cifs"],
  [0x517bn, "smb"],
  [0x01021997n, "9p"],
  [0x65735546n, "fuse"],
  [0x794c7630n, "overlay"],
]);

function normalizedFilesystemType(type: bigint | number): bigint {
  if (typeof type === "number" && !Number.isSafeInteger(type)) {
    throw new SecureHostStateFilesystemError("filesystem type must be a safe integer");
  }
  return BigInt.asUintN(32, BigInt(type));
}

/** Versioned, fail-closed policy for filesystems on which SQLite WAL is allowed. */
export function classifyHostStateFilesystemType(
  type: bigint | number,
): HostStateFilesystemClassification {
  const normalizedType = normalizedFilesystemType(type);
  const allowedName = ALLOWED_LOCAL_FILESYSTEMS.get(normalizedType);
  return Object.freeze({
    allowed: allowedName !== undefined,
    name:
      allowedName ??
      DENIED_FILESYSTEM_NAMES.get(normalizedType) ??
      `unknown-0x${normalizedType.toString(16)}`,
    policyVersion: HOST_STATE_LOCAL_FILESYSTEM_POLICY_VERSION,
  });
}

export class SecureHostStateFilesystemError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecureHostStateFilesystemError";
  }
}

/** Fail before touching state unless Linux supplies uid and proc-fd primitives. */
export function assertSecureHostStatePlatform(
  platform: string = process.platform,
  getuid: (() => number) | undefined = process.getuid,
): number {
  if (platform !== "linux") {
    throw new SecureHostStateFilesystemError("secure host state is supported only on Linux");
  }
  if (typeof getuid !== "function") {
    throw new SecureHostStateFilesystemError("secure host state requires a numeric process uid");
  }
  const uid = getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new SecureHostStateFilesystemError("secure host state requires a numeric process uid");
  }
  if (typeof FS.O_NOFOLLOW !== "number" || typeof FS.O_DIRECTORY !== "number") {
    throw new SecureHostStateFilesystemError(
      "secure host state requires O_NOFOLLOW and O_DIRECTORY",
    );
  }
  let procFd: BigIntStats;
  try {
    procFd = lstatSync("/proc/self/fd", { bigint: true });
  } catch (error) {
    throw new SecureHostStateFilesystemError("secure host state requires /proc/self/fd", {
      cause: error,
    });
  }
  if (!procFd.isDirectory()) {
    throw new SecureHostStateFilesystemError("secure host state requires /proc/self/fd");
  }
  return uid;
}

interface Guardian {
  readonly absolutePath: string;
  readonly descriptorPath: string;
  readonly fd: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly kind: "directory" | "file";
  readonly exactMode: number | null;
  readonly forbiddenModeMask: number;
}

function procChild(parentFd: number, name: string): string {
  return `/proc/self/fd/${parentFd}/${name}`;
}

function modeOf(stat: BigIntStats): number {
  return Number(stat.mode & 0o777n);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readPathStat(path: string, label: string): BigIntStats {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    throw new SecureHostStateFilesystemError(`${label} path is unavailable`, { cause: error });
  }
}

function assertGuardianIdentity(guardian: Guardian, uid: number): void {
  let descriptorStat: BigIntStats;
  let fdStat: BigIntStats;
  try {
    fdStat = fstatSync(guardian.fd, { bigint: true });
    descriptorStat = statSync(guardian.descriptorPath, { bigint: true });
  } catch (error) {
    throw new SecureHostStateFilesystemError(`${guardian.kind} guardian is unavailable`, {
      cause: error,
    });
  }
  const absoluteStat = readPathStat(guardian.absolutePath, guardian.kind);
  if (
    fdStat.dev !== guardian.dev ||
    fdStat.ino !== guardian.ino ||
    !sameIdentity(fdStat, descriptorStat) ||
    !sameIdentity(fdStat, absoluteStat)
  ) {
    throw new SecureHostStateFilesystemError(`${guardian.kind} path identity changed`);
  }
  const correctKind = guardian.kind === "directory" ? fdStat.isDirectory() : fdStat.isFile();
  if (!correctKind || fdStat.uid !== BigInt(uid)) {
    throw new SecureHostStateFilesystemError(`${guardian.kind} ownership or type is unsafe`);
  }
  if (guardian.kind === "file" && fdStat.nlink !== 1n) {
    throw new SecureHostStateFilesystemError("host state file must have exactly one link");
  }
  if (guardian.exactMode !== null && modeOf(fdStat) !== guardian.exactMode) {
    throw new SecureHostStateFilesystemError(
      `${guardian.kind} mode must be ${guardian.exactMode.toString(8)}`,
    );
  }
  if ((modeOf(fdStat) & guardian.forbiddenModeMask) !== 0) {
    throw new SecureHostStateFilesystemError(
      `${guardian.kind} mode contains forbidden permission bits`,
    );
  }
}

function directoryGuardian(
  absolutePath: string,
  openedPath: string,
  fd: number,
  uid: number,
  exactMode: number | null,
  stateHome: boolean,
): Guardian {
  const fdStat = fstatSync(fd, { bigint: true });
  const descriptorStat = readPathStat(openedPath, "directory");
  const absoluteStat = readPathStat(absolutePath, "directory");
  if (
    !fdStat.isDirectory() ||
    !sameIdentity(fdStat, descriptorStat) ||
    !sameIdentity(fdStat, absoluteStat)
  ) {
    throw new SecureHostStateFilesystemError("directory path identity changed during secure open");
  }
  if (fdStat.uid !== BigInt(uid)) {
    throw new SecureHostStateFilesystemError(
      "host state directory must be owned by the current uid",
    );
  }
  const mode = modeOf(fdStat);
  if (stateHome && (mode & 0o022) !== 0) {
    throw new SecureHostStateFilesystemError(
      "host state home must not be group- or world-writable",
    );
  }
  if (exactMode !== null && mode !== exactMode) {
    throw new SecureHostStateFilesystemError(
      `host state directory mode must be ${exactMode.toString(8)}`,
    );
  }
  return {
    absolutePath,
    descriptorPath: `/proc/self/fd/${fd}`,
    fd,
    dev: fdStat.dev,
    ino: fdStat.ino,
    kind: "directory",
    exactMode,
    forbiddenModeMask: stateHome ? 0o022 : 0,
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function assertAbsent(parentFd: number, name: string, absolutePath: string, label: string): void {
  for (const path of [procChild(parentFd, name), absolutePath]) {
    try {
      lstatSync(path, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw new SecureHostStateFilesystemError(`cannot inspect ${label}`, { cause: error });
    }
    throw new SecureHostStateFilesystemError(`${label} is forbidden`);
  }
}

function pathEntryIsPresent(
  parentFd: number,
  name: string,
  absolutePath: string,
  label: string,
): boolean {
  const results: boolean[] = [];
  for (const path of [procChild(parentFd, name), absolutePath]) {
    try {
      lstatSync(path, { bigint: true });
      results.push(true);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        results.push(false);
      } else {
        throw new SecureHostStateFilesystemError(`cannot inspect ${label}`, { cause: error });
      }
    }
  }
  if (results[0] !== results[1]) {
    throw new SecureHostStateFilesystemError(`${label} path changed during secure inspection`);
  }
  return results[0] === true;
}

interface OpenedFile {
  readonly guardian: Guardian;
  readonly created: boolean;
}

function openStateFile(
  parent: Guardian,
  absolutePath: string,
  name: string,
  uid: number,
): OpenedFile {
  const descriptorPath = procChild(parent.fd, name);
  const commonFlags = FS.O_RDWR | FS.O_NOFOLLOW | FS.O_NONBLOCK;
  let fd: number;
  let created = false;
  try {
    fd = openSync(descriptorPath, commonFlags);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw new SecureHostStateFilesystemError(`cannot securely open ${name}`, { cause: error });
    }
    try {
      fd = openSync(descriptorPath, commonFlags | FS.O_CREAT | FS.O_EXCL, 0o600);
      created = true;
    } catch (createError) {
      throw new SecureHostStateFilesystemError(`cannot securely create ${name}`, {
        cause: createError,
      });
    }
  }
  try {
    if (created) fchmodSync(fd, 0o600);
    const fdStat = fstatSync(fd, { bigint: true });
    const descriptorStat = readPathStat(descriptorPath, "host state file");
    const absoluteStat = readPathStat(absolutePath, "host state file");
    if (
      !fdStat.isFile() ||
      !sameIdentity(fdStat, descriptorStat) ||
      !sameIdentity(fdStat, absoluteStat)
    ) {
      throw new SecureHostStateFilesystemError(
        "host state file identity changed during secure open",
      );
    }
    if (fdStat.uid !== BigInt(uid) || modeOf(fdStat) !== 0o600 || fdStat.nlink !== 1n) {
      throw new SecureHostStateFilesystemError(
        "host state files must be owner-only regular files with one link",
      );
    }
    if (fdStat.dev !== parent.dev) {
      throw new SecureHostStateFilesystemError(
        "host state files must share the identity filesystem",
      );
    }
    return {
      guardian: {
        absolutePath,
        descriptorPath: `/proc/self/fd/${fd}`,
        fd,
        dev: fdStat.dev,
        ino: fdStat.ino,
        kind: "file",
        exactMode: 0o600,
        forbiddenModeMask: 0,
      },
      created,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export interface SecureHostStateFilesystem {
  readonly databasePath: string;
  readonly databaseDescriptorPath: string;
  readonly databaseWasCreated: boolean;
  readonly filesystem: HostStateFilesystemClassification;
  assertStable(): void;
  fsync(): void;
  close(): void;
}

export interface OpenSecureHostStateFilesystemOptions {
  /** Runs after the database inode is guarded but before WAL/SHM names are reserved. */
  readonly preflightDatabase?: (
    databaseDescriptorPath: string,
    databaseWasCreated: boolean,
    facts: Readonly<{ existingWalByteLength: number }>,
  ) => void;
}

class SecureHostStateFilesystemGuardian implements SecureHostStateFilesystem {
  readonly databasePath: string;
  readonly databaseDescriptorPath: string;
  readonly databaseWasCreated: boolean;
  readonly filesystem: HostStateFilesystemClassification;
  readonly #uid: number;
  readonly #directories: readonly Guardian[];
  readonly #files: readonly Guardian[];
  readonly #journalPath: string;
  #closed = false;

  constructor(
    databasePath: string,
    databaseWasCreated: boolean,
    filesystem: HostStateFilesystemClassification,
    uid: number,
    directories: readonly Guardian[],
    files: readonly Guardian[],
  ) {
    this.databasePath = databasePath;
    const databaseGuardian = files[0];
    if (databaseGuardian === undefined) {
      throw new SecureHostStateFilesystemError("database guardian is unavailable");
    }
    this.databaseDescriptorPath = databaseGuardian.descriptorPath;
    this.databaseWasCreated = databaseWasCreated;
    this.filesystem = filesystem;
    this.#uid = uid;
    this.#directories = directories;
    this.#files = files;
    this.#journalPath = `${databasePath}-journal`;
  }

  #assertOpen(): void {
    if (this.#closed) throw new SecureHostStateFilesystemError("host state guardian is closed");
  }

  assertStable(): void {
    this.#assertOpen();
    for (const guardian of this.#directories) assertGuardianIdentity(guardian, this.#uid);
    for (const guardian of this.#files) assertGuardianIdentity(guardian, this.#uid);
    const identityDirectory = this.#directories.at(-1);
    if (identityDirectory === undefined) {
      throw new SecureHostStateFilesystemError("identity directory guardian is unavailable");
    }
    assertAbsent(
      identityDirectory.fd,
      `${HOST_STATE_DATABASE_BASENAME}-journal`,
      this.#journalPath,
      "SQLite rollback journal",
    );
    let actualFilesystem: HostStateFilesystemClassification;
    try {
      actualFilesystem = classifyHostStateFilesystemType(
        statfsSync(identityDirectory.descriptorPath, { bigint: true }).type,
      );
    } catch (error) {
      if (error instanceof SecureHostStateFilesystemError) throw error;
      throw new SecureHostStateFilesystemError("cannot revalidate host state filesystem", {
        cause: error,
      });
    }
    if (!actualFilesystem.allowed || actualFilesystem.name !== this.filesystem.name) {
      throw new SecureHostStateFilesystemError(
        "host state filesystem changed or is no longer allowed",
      );
    }
  }

  fsync(): void {
    this.assertStable();
    for (const guardian of this.#files) fsyncSync(guardian.fd);
    for (const guardian of [...this.#directories].reverse()) fsyncSync(guardian.fd);
    this.assertStable();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    let firstError: unknown;
    for (const guardian of [...this.#files, ...[...this.#directories].reverse()]) {
      try {
        closeSync(guardian.fd);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}

interface StateLayout {
  readonly stateHome: string;
  readonly appDirectory: string;
  readonly identitiesDirectory: string;
  readonly identityDirectory: string;
}

function parseStateLayout(databasePath: string): StateLayout {
  if (!isAbsolute(databasePath) || normalize(databasePath) !== databasePath) {
    throw new SecureHostStateFilesystemError(
      "host state database path must be normalized and absolute",
    );
  }
  if (basename(databasePath) !== HOST_STATE_DATABASE_BASENAME) {
    throw new SecureHostStateFilesystemError(
      `host state database must be named ${HOST_STATE_DATABASE_BASENAME}`,
    );
  }
  const identityDirectory = dirname(databasePath);
  const identitiesDirectory = dirname(identityDirectory);
  const appDirectory = dirname(identitiesDirectory);
  const stateHome = dirname(appDirectory);
  if (
    basename(identitiesDirectory) !== "identities" ||
    basename(appDirectory) !== "remote-claw" ||
    stateHome === parse(stateHome).root
  ) {
    throw new SecureHostStateFilesystemError("host state database path has an invalid layout");
  }
  return { stateHome, appDirectory, identitiesDirectory, identityDirectory };
}

/**
 * Open a descriptor-anchored Linux state tree and hold guardians for its DB and
 * SQLite WAL/SHM names until close. The SQLite connection must be closed first.
 */
export function openSecureHostStateFilesystem(
  databasePath: string,
  options: OpenSecureHostStateFilesystemOptions = {},
): SecureHostStateFilesystem {
  const preflightDatabase = options.preflightDatabase;
  if (preflightDatabase !== undefined && typeof preflightDatabase !== "function") {
    throw new SecureHostStateFilesystemError("database preflight must be a function");
  }
  const uid = assertSecureHostStatePlatform();
  const layout = parseStateLayout(databasePath);
  const root = parse(databasePath).root;
  const components = relative(root, layout.identityDirectory).split(sep).filter(Boolean);
  const securedPaths = new Map<string, { exactMode: number | null; stateHome: boolean }>([
    [layout.stateHome, { exactMode: null, stateHome: true }],
    [layout.appDirectory, { exactMode: 0o700, stateHome: false }],
    [layout.identitiesDirectory, { exactMode: 0o700, stateHome: false }],
    [layout.identityDirectory, { exactMode: 0o700, stateHome: false }],
  ]);
  const allDirectoryGuardians: Guardian[] = [];
  const retainedDirectories: Guardian[] = [];
  const fileGuardians: Guardian[] = [];
  const rootFd = openSync(root, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  let rootCloseAttempted = false;
  let parentFd = rootFd;
  let parentAbsolute = root;
  try {
    for (const component of components) {
      const absolutePath = normalize(
        `${parentAbsolute}${parentAbsolute.endsWith(sep) ? "" : sep}${component}`,
      );
      const descriptorPath = procChild(parentFd, component);
      let childFd: number;
      let created = false;
      try {
        childFd = openSync(descriptorPath, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw new SecureHostStateFilesystemError("cannot securely open host state directory", {
            cause: error,
          });
        }
        try {
          mkdirSync(descriptorPath, { mode: 0o700 });
          fsyncSync(parentFd);
          childFd = openSync(descriptorPath, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
          created = true;
        } catch (createError) {
          throw new SecureHostStateFilesystemError("cannot securely create host state directory", {
            cause: createError,
          });
        }
      }
      try {
        if (created) {
          fchmodSync(childFd, 0o700);
          fsyncSync(childFd);
          fsyncSync(parentFd);
        }
        const security = securedPaths.get(absolutePath);
        if (security !== undefined) {
          const guardian = directoryGuardian(
            absolutePath,
            descriptorPath,
            childFd,
            uid,
            security.exactMode,
            security.stateHome,
          );
          allDirectoryGuardians.push(guardian);
          retainedDirectories.push(guardian);
        } else {
          const stat = fstatSync(childFd, { bigint: true });
          allDirectoryGuardians.push({
            absolutePath,
            descriptorPath: `/proc/self/fd/${childFd}`,
            fd: childFd,
            dev: stat.dev,
            ino: stat.ino,
            kind: "directory",
            exactMode: null,
            forbiddenModeMask: 0,
          });
        }
      } catch (error) {
        closeSync(childFd);
        throw error;
      }
      parentFd = childFd;
      parentAbsolute = absolutePath;
    }

    const identityDirectory = retainedDirectories.at(-1);
    if (
      identityDirectory === undefined ||
      identityDirectory.absolutePath !== layout.identityDirectory
    ) {
      throw new SecureHostStateFilesystemError("identity directory guardian is unavailable");
    }
    let filesystem: HostStateFilesystemClassification;
    try {
      filesystem = classifyHostStateFilesystemType(
        statfsSync(identityDirectory.descriptorPath, { bigint: true }).type,
      );
    } catch (error) {
      if (error instanceof SecureHostStateFilesystemError) throw error;
      throw new SecureHostStateFilesystemError("cannot inspect host state filesystem", {
        cause: error,
      });
    }
    if (!filesystem.allowed) {
      throw new SecureHostStateFilesystemError(
        `host state filesystem ${filesystem.name} is not allowed by policy v${filesystem.policyVersion}`,
      );
    }
    assertAbsent(
      identityDirectory.fd,
      `${HOST_STATE_DATABASE_BASENAME}-journal`,
      `${databasePath}-journal`,
      "SQLite rollback journal",
    );

    const databaseWasPresent = pathEntryIsPresent(
      identityDirectory.fd,
      HOST_STATE_DATABASE_BASENAME,
      databasePath,
      "host state database",
    );
    const walWasPresent = pathEntryIsPresent(
      identityDirectory.fd,
      `${HOST_STATE_DATABASE_BASENAME}-wal`,
      `${databasePath}-wal`,
      "SQLite WAL",
    );
    const shmWasPresent = pathEntryIsPresent(
      identityDirectory.fd,
      `${HOST_STATE_DATABASE_BASENAME}-shm`,
      `${databasePath}-shm`,
      "SQLite shared memory",
    );
    if (!databaseWasPresent) {
      if (walWasPresent || shmWasPresent) {
        throw new SecureHostStateFilesystemError(
          "WAL/SHM sidecars cannot exist without a host state database",
        );
      }
    }

    const database = openStateFile(
      identityDirectory,
      databasePath,
      HOST_STATE_DATABASE_BASENAME,
      uid,
    );
    fileGuardians.push(database.guardian);
    if (database.created === databaseWasPresent) {
      throw new SecureHostStateFilesystemError(
        "host state database presence changed during secure open",
      );
    }
    // Guard a crash-surviving WAL before preflight. If no WAL exists, preflight
    // runs before creating either sidecar so clean future versions are untouched.
    let wal: OpenedFile | undefined;
    if (walWasPresent) {
      wal = openStateFile(
        identityDirectory,
        `${databasePath}-wal`,
        `${HOST_STATE_DATABASE_BASENAME}-wal`,
        uid,
      );
      fileGuardians.push(wal.guardian);
      if (wal.created) {
        throw new SecureHostStateFilesystemError("SQLite WAL presence changed during secure open");
      }
    }
    const walSize = wal === undefined ? 0n : fstatSync(wal.guardian.fd, { bigint: true }).size;
    if (walSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SecureHostStateFilesystemError("SQLite WAL is too large to inspect safely");
    }
    preflightDatabase?.(
      database.guardian.descriptorPath,
      database.created,
      Object.freeze({ existingWalByteLength: Number(walSize) }),
    );
    if (wal === undefined) {
      wal = openStateFile(
        identityDirectory,
        `${databasePath}-wal`,
        `${HOST_STATE_DATABASE_BASENAME}-wal`,
        uid,
      );
      fileGuardians.push(wal.guardian);
      if (!wal.created) {
        throw new SecureHostStateFilesystemError("SQLite WAL appeared during secure open");
      }
    }
    // Reserve SHM only after preflight; SQLite initializes the empty pair in place.
    const shm = openStateFile(
      identityDirectory,
      `${databasePath}-shm`,
      `${HOST_STATE_DATABASE_BASENAME}-shm`,
      uid,
    );
    fileGuardians.push(shm.guardian);
    if (shm.created === shmWasPresent) {
      throw new SecureHostStateFilesystemError(
        "SQLite shared-memory presence changed during secure open",
      );
    }
    for (const file of fileGuardians) fsyncSync(file.fd);
    fsyncSync(identityDirectory.fd);

    for (let index = allDirectoryGuardians.length - 1; index >= 0; index--) {
      const guardian = allDirectoryGuardians[index];
      if (guardian !== undefined && !retainedDirectories.includes(guardian)) {
        allDirectoryGuardians.splice(index, 1);
        closeSync(guardian.fd);
      }
    }
    const result = new SecureHostStateFilesystemGuardian(
      databasePath,
      database.created,
      filesystem,
      uid,
      retainedDirectories,
      fileGuardians,
    );
    result.assertStable();
    rootCloseAttempted = true;
    try {
      closeSync(rootFd);
    } catch (error) {
      throw new SecureHostStateFilesystemError(
        "cannot close the host state traversal-root descriptor",
        { cause: error },
      );
    }
    return result;
  } catch (error) {
    for (const guardian of [...fileGuardians, ...allDirectoryGuardians].reverse()) {
      try {
        closeSync(guardian.fd);
      } catch {
        // Preserve the security failure that triggered cleanup.
      }
    }
    if (!rootCloseAttempted) {
      rootCloseAttempted = true;
      try {
        closeSync(rootFd);
      } catch {
        // Preserve the security failure that triggered cleanup.
      }
    }
    throw error;
  }
}
