import {
  type BigIntStats,
  closeSync,
  constants as FS,
  fstatSync,
  openSync,
  readlinkSync,
  readSync,
  statfsSync,
  statSync,
} from "node:fs";
import { HostStateContractError, type NativeRuntimeId, parseA1CanonicalId } from "../state/ids.js";
import { NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID } from "../state/native-binding-authority-evidence.js";
import {
  type CanonicalWorkspaceEvidenceArtifact,
  canonicalDirectoryPathDigest,
  canonicalLinuxAllowedRootAncestryArtifact,
  canonicalLinuxMountNamespaceIdentityArtifact,
  canonicalLinuxNoFollowFilesystemIdentityArtifact,
  canonicalPosixCanonicalDirectoryEvidenceArtifact,
  LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID,
  LINUX_ALLOWED_ROOT_SUFFIX_MOUNT_POLICY,
  LINUX_DIRECTORY_FILE_KIND,
  LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
  LINUX_MOUNT_NAMESPACE_KIND,
  LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID,
  LINUX_NSFS_MAGIC_DECIMAL,
  type LinuxAllowedRootAncestryEntryV1,
  type LinuxAllowedRootAncestryV1,
  type LinuxMountNamespaceIdentityV1,
  type LinuxNoFollowFilesystemIdentityV1,
  type ParsedPosixAbsoluteDirectory,
  POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID,
  type PosixCanonicalDirectoryEvidenceV1,
  parsePosixAbsoluteDirectory,
  u64DecimalFromBigInt,
} from "../state/native-binding-authority-workspace-evidence.js";

const PROC_SUPER_MAGIC = 0x9fa0n;
const NSFS_MAGIC = 0x6e736673n;
const MAX_PROC_TEXT_BYTES = 16_384;
const MAX_BOOT_ID_BYTES = 37;
const U64_MAX = 18_446_744_073_709_551_615n;
const SIGNED_U32_MIN = -2_147_483_648n;
const U32_MAX = 4_294_967_295n;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type LinuxWorkspaceCollectionErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_INPUT"
  | "TARGET_OUTSIDE_ALLOWED_ROOT"
  | "PROCFS_INVALID"
  | "BOOT_ID_INVALID"
  | "NAMESPACE_INVALID"
  | "PATH_OPEN_FAILED"
  | "PATH_COMPONENT_REFUSED"
  | "NOT_DIRECTORY"
  | "UNLINKED"
  | "FD_IDENTITY_MISMATCH"
  | "FDINFO_INVALID"
  | "FILESYSTEM_INVALID"
  | "MOUNT_CROSSING"
  | "CHANGED"
  | "CLOSE_FAILED"
  | "CANONICALIZATION_FAILED"
  | "IO";

export class LinuxWorkspaceCollectionError extends Error {
  readonly code: LinuxWorkspaceCollectionErrorCode;

  constructor(code: LinuxWorkspaceCollectionErrorCode, message: string) {
    super(message);
    this.name = "LinuxWorkspaceCollectionError";
    this.code = code;
  }

  static is(value: unknown): value is LinuxWorkspaceCollectionError {
    return value instanceof LinuxWorkspaceCollectionError;
  }
}

export interface CollectLinuxWorkspaceEvidenceInput {
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly allowedRoot: string;
  readonly canonicalDirectory: string;
}

interface CollectedLinuxWorkspaceEvidenceShape {
  readonly mountNamespace: CanonicalWorkspaceEvidenceArtifact<
    "workspace.mount_namespace",
    LinuxMountNamespaceIdentityV1
  >;
  readonly canonicalDirectory: CanonicalWorkspaceEvidenceArtifact<
    "workspace.canonical_directory",
    PosixCanonicalDirectoryEvidenceV1
  >;
  readonly filesystemIdentity: CanonicalWorkspaceEvidenceArtifact<
    "workspace.filesystem_identity",
    LinuxNoFollowFilesystemIdentityV1
  >;
  readonly allowedRoot: CanonicalWorkspaceEvidenceArtifact<
    "workspace.allowed_root",
    LinuxAllowedRootAncestryV1
  >;
}

declare const COLLECTED_LINUX_WORKSPACE_EVIDENCE: unique symbol;

/**
 * Nominal result of one complete synchronous Linux observation. The marker is not runtime
 * authenticity; an authority consumer must independently verify the four bytes and its E1a parent.
 */
export type CollectedLinuxWorkspaceEvidence = Readonly<
  CollectedLinuxWorkspaceEvidenceShape & {
    readonly [COLLECTED_LINUX_WORKSPACE_EVIDENCE]: true;
  }
>;

type ParsedCollectionInput = Readonly<{
  runtimeId: NativeRuntimeId;
  nativeIncarnation: number;
  allowedRoot: ParsedPosixAbsoluteDirectory;
  canonicalDirectory: ParsedPosixAbsoluteDirectory;
}>;

type OwnedFd = {
  readonly fd: number;
  readonly generation: number;
  open: boolean;
};

type DirectoryFact = Readonly<{
  device: bigint;
  inode: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  mountId: bigint;
  filesystemMagic: bigint;
}>;

type NamespaceFact = Readonly<{
  device: bigint;
  inode: bigint;
  filesystemMagic: typeof NSFS_MAGIC;
}>;

type RetainedChain = Readonly<{
  guardians: readonly OwnedFd[];
  components: readonly string[];
}>;

type DirectorySweep = Readonly<{
  allowedRoot: readonly DirectoryFact[];
  target: readonly DirectoryFact[];
}>;

type WorkspaceObservation = Readonly<{
  bootId: string;
  namespace: NamespaceFact;
  allowedRootFacts: readonly DirectoryFact[];
  targetFacts: readonly DirectoryFact[];
}>;

function collectionError(
  code: LinuxWorkspaceCollectionErrorCode,
  message: string,
): LinuxWorkspaceCollectionError {
  return new LinuxWorkspaceCollectionError(code, message);
}

function normalizeObservationFailure(value: unknown): LinuxWorkspaceCollectionError {
  if (LinuxWorkspaceCollectionError.is(value)) return value;
  return collectionError("IO", "Linux workspace evidence observation failed");
}

function isErrno(value: unknown, ...codes: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    codes.includes((value as NodeJS.ErrnoException).code ?? "")
  );
}

function exactInputRecord(value: unknown): Record<string, unknown> {
  const keys = ["runtimeId", "nativeIncarnation", "allowedRoot", "canonicalDirectory"] as const;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw collectionError("INVALID_INPUT", "workspace evidence input is invalid");
  }
  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw collectionError("INVALID_INPUT", "workspace evidence input is invalid");
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key as (typeof keys)[number]))
  ) {
    throw collectionError("INVALID_INPUT", "workspace evidence input is invalid");
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw collectionError("INVALID_INPUT", "workspace evidence input is invalid");
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw collectionError("INVALID_INPUT", "workspace evidence input is invalid");
    }
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function parseCollectionInput(value: CollectLinuxWorkspaceEvidenceInput): ParsedCollectionInput {
  try {
    const row = exactInputRecord(value);
    if (
      !Number.isSafeInteger(row.nativeIncarnation) ||
      (row.nativeIncarnation as number) <= 0 ||
      Object.is(row.nativeIncarnation, -0)
    ) {
      throw collectionError("INVALID_INPUT", "workspace evidence input is invalid");
    }
    const allowedRoot = parsePosixAbsoluteDirectory(
      row.allowedRoot,
      "collectLinuxWorkspaceEvidence.allowedRoot",
    );
    const canonicalDirectory = parsePosixAbsoluteDirectory(
      row.canonicalDirectory,
      "collectLinuxWorkspaceEvidence.canonicalDirectory",
    );
    if (
      allowedRoot.components.length > canonicalDirectory.components.length ||
      allowedRoot.components.some(
        (component, index) => component !== canonicalDirectory.components[index],
      )
    ) {
      throw collectionError(
        "TARGET_OUTSIDE_ALLOWED_ROOT",
        "workspace target is outside the configured allowed root",
      );
    }
    return Object.freeze({
      runtimeId: parseA1CanonicalId(
        "nativeRuntime",
        row.runtimeId,
        "collectLinuxWorkspaceEvidence.runtimeId",
      ),
      nativeIncarnation: row.nativeIncarnation as number,
      allowedRoot,
      canonicalDirectory,
    });
  } catch (error) {
    if (LinuxWorkspaceCollectionError.is(error)) throw error;
    if (error instanceof HostStateContractError) {
      throw collectionError("INVALID_INPUT", "workspace evidence input is invalid");
    }
    throw collectionError("INVALID_INPUT", "workspace evidence input is invalid");
  }
}

class FdLedger {
  readonly #owned: OwnedFd[] = [];
  #nextGeneration = 1;

  open(path: string, flags: number): OwnedFd {
    const owner: OwnedFd = {
      fd: openSync(path, flags),
      generation: this.#nextGeneration++,
      open: true,
    };
    this.#owned.push(owner);
    return owner;
  }

  /** Mark before close: Linux may release/reuse the numeric FD even when close reports an error. */
  tryClose(owner: OwnedFd): LinuxWorkspaceCollectionError | undefined {
    if (!owner.open) return undefined;
    owner.open = false;
    try {
      closeSync(owner.fd);
      return undefined;
    } catch {
      return collectionError("CLOSE_FAILED", "could not close Linux workspace evidence descriptor");
    }
  }

  close(owner: OwnedFd): void {
    const failure = this.tryClose(owner);
    if (failure !== undefined) throw failure;
  }

  cleanup(): LinuxWorkspaceCollectionError | undefined {
    let firstFailure: LinuxWorkspaceCollectionError | undefined;
    for (let index = this.#owned.length - 1; index >= 0; index--) {
      const owner = this.#owned[index];
      if (owner === undefined) continue;
      const failure = this.tryClose(owner);
      if (firstFailure === undefined && failure !== undefined) firstFailure = failure;
    }
    return firstFailure;
  }
}

function assertPlatform(): void {
  if (
    process.platform !== "linux" ||
    typeof FS.O_NOFOLLOW !== "number" ||
    typeof FS.O_DIRECTORY !== "number" ||
    typeof FS.O_NONBLOCK !== "number"
  ) {
    throw collectionError(
      "UNSUPPORTED_PLATFORM",
      "workspace evidence collection requires Linux descriptor primitives",
    );
  }
}

function normalizeFilesystemType(
  value: bigint | number,
  code: "PROCFS_INVALID" | "NAMESPACE_INVALID" | "FILESYSTEM_INVALID",
): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw collectionError(code, "Linux filesystem identity is invalid");
  }
  const numeric = BigInt(value);
  if (numeric < SIGNED_U32_MIN || numeric > U32_MAX) {
    throw collectionError(code, "Linux filesystem identity is invalid");
  }
  return BigInt.asUintN(32, numeric);
}

function statfsType(
  path: string,
  code: "PROCFS_INVALID" | "NAMESPACE_INVALID" | "FILESYSTEM_INVALID",
): bigint {
  try {
    return normalizeFilesystemType(statfsSync(path, { bigint: true }).type, code);
  } catch (error) {
    if (LinuxWorkspaceCollectionError.is(error)) throw error;
    throw collectionError(code, "Linux filesystem identity is invalid");
  }
}

function assertProcfs(): void {
  for (const path of ["/proc/thread-self", "/proc/self/fd", "/proc/self/fdinfo"]) {
    if (statfsType(path, "PROCFS_INVALID") !== PROC_SUPER_MAGIC) {
      throw collectionError("PROCFS_INVALID", "trusted Linux procfs is unavailable");
    }
  }
}

function readBounded(
  fd: number,
  maxBytes: number,
  code: "BOOT_ID_INVALID" | "FDINFO_INVALID",
  message: string,
): Buffer {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes.byteLength - offset) {
        throw collectionError(code, message);
      }
      if (count === 0) return bytes.subarray(0, offset);
      offset += count;
    }
  } catch (error) {
    if (LinuxWorkspaceCollectionError.is(error)) throw error;
    throw collectionError(code, message);
  }
  throw collectionError(code, message);
}

function decodeUtf8(
  bytes: Uint8Array,
  code: "BOOT_ID_INVALID" | "FDINFO_INVALID",
  message: string,
) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw collectionError(code, message);
  }
}

function openBootId(ledger: FdLedger): string {
  let owner: OwnedFd;
  try {
    owner = ledger.open(
      "/proc/sys/kernel/random/boot_id",
      FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK,
    );
  } catch {
    throw collectionError("BOOT_ID_INVALID", "Linux boot identity is unavailable");
  }
  const text = decodeUtf8(
    readBounded(owner.fd, MAX_BOOT_ID_BYTES, "BOOT_ID_INVALID", "Linux boot identity is invalid"),
    "BOOT_ID_INVALID",
    "Linux boot identity is invalid",
  );
  const bootId = text.endsWith("\n") ? text.slice(0, -1) : text;
  if ((text.length !== 36 && text.length !== 37) || !BOOT_ID.test(bootId)) {
    throw collectionError("BOOT_ID_INVALID", "Linux boot identity is invalid");
  }
  return bootId;
}

function withTemporaryFd<T>(
  ledger: FdLedger,
  path: string,
  flags: number,
  code: LinuxWorkspaceCollectionErrorCode,
  message: string,
  read: (fd: number) => T,
): T {
  let owner: OwnedFd;
  try {
    owner = ledger.open(path, flags);
  } catch {
    throw collectionError(code, message);
  }
  let result: T | undefined;
  let failure: unknown;
  try {
    result = read(owner.fd);
  } catch (error) {
    failure = error;
  }
  const closeFailure = ledger.tryClose(owner);
  if (failure !== undefined) throw failure;
  if (closeFailure !== undefined) throw closeFailure;
  return result as T;
}

function readMountId(ledger: FdLedger, targetFd: number): bigint {
  const text = withTemporaryFd(
    ledger,
    `/proc/self/fdinfo/${targetFd}`,
    FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK,
    "FDINFO_INVALID",
    "Linux descriptor metadata is invalid",
    (fd) =>
      decodeUtf8(
        readBounded(
          fd,
          MAX_PROC_TEXT_BYTES,
          "FDINFO_INVALID",
          "Linux descriptor metadata is invalid",
        ),
        "FDINFO_INVALID",
        "Linux descriptor metadata is invalid",
      ),
  );
  let mountId: bigint | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("mnt_id:")) continue;
    if (mountId !== undefined || !/^mnt_id:\t(?:0|[1-9][0-9]{0,19})$/.test(line)) {
      throw collectionError("FDINFO_INVALID", "Linux descriptor metadata is invalid");
    }
    const numeric = BigInt(line.slice("mnt_id:\t".length));
    if (numeric <= 0n || numeric > U64_MAX) {
      throw collectionError("FDINFO_INVALID", "Linux descriptor metadata is invalid");
    }
    mountId = numeric;
  }
  if (mountId === undefined) {
    throw collectionError("FDINFO_INVALID", "Linux descriptor metadata is invalid");
  }
  return mountId;
}

function requireU64(
  value: bigint,
  allowZero: boolean,
  code: "NAMESPACE_INVALID" | "FILESYSTEM_INVALID",
): bigint {
  if (typeof value !== "bigint" || value < (allowZero ? 0n : 1n) || value > U64_MAX) {
    throw collectionError(code, "Linux kernel identity is outside the selected range");
  }
  return value;
}

function descriptorStat(fd: number, code: "NAMESPACE_INVALID" | "FILESYSTEM_INVALID") {
  try {
    return statSync(`/proc/self/fd/${fd}`, { bigint: true });
  } catch {
    throw collectionError(code, "Linux descriptor identity is unavailable");
  }
}

function sampleNamespace(ledger: FdLedger, owner: OwnedFd): NamespaceFact {
  let stat: BigIntStats;
  try {
    stat = fstatSync(owner.fd, { bigint: true });
  } catch {
    throw collectionError("NAMESPACE_INVALID", "Linux mount namespace identity is unavailable");
  }
  if (!stat.isFile() || stat.nlink <= 0n) {
    throw collectionError("NAMESPACE_INVALID", "Linux mount namespace identity is invalid");
  }
  const linkedStat = descriptorStat(owner.fd, "NAMESPACE_INVALID");
  if (linkedStat.dev !== stat.dev || linkedStat.ino !== stat.ino) {
    throw collectionError("NAMESPACE_INVALID", "Linux mount namespace identity changed");
  }
  const filesystemMagic = statfsType(`/proc/self/fd/${owner.fd}`, "NAMESPACE_INVALID");
  if (filesystemMagic !== NSFS_MAGIC) {
    throw collectionError("NAMESPACE_INVALID", "Linux mount namespace filesystem is invalid");
  }
  let link: string;
  try {
    link = readlinkSync(`/proc/self/fd/${owner.fd}`);
  } catch {
    throw collectionError("NAMESPACE_INVALID", "Linux mount namespace link is unavailable");
  }
  const inode = requireU64(stat.ino, false, "NAMESPACE_INVALID");
  if (link !== `mnt:[${inode.toString(10)}]`) {
    throw collectionError("NAMESPACE_INVALID", "Linux mount namespace link is invalid");
  }
  // Operational only, but an exact fdinfo record is required for every held kernel object.
  readMountId(ledger, owner.fd);
  return Object.freeze({
    device: requireU64(stat.dev, true, "NAMESPACE_INVALID"),
    inode,
    filesystemMagic: NSFS_MAGIC,
  });
}

function openNamespace(ledger: FdLedger): Readonly<{ owner: OwnedFd; fact: NamespaceFact }> {
  let owner: OwnedFd;
  try {
    owner = ledger.open("/proc/thread-self/ns/mnt", FS.O_RDONLY | FS.O_NONBLOCK);
  } catch {
    throw collectionError("NAMESPACE_INVALID", "Linux mount namespace is unavailable");
  }
  return Object.freeze({ owner, fact: sampleNamespace(ledger, owner) });
}

function validateOpenDirectory(owner: OwnedFd): void {
  let stat: BigIntStats;
  try {
    stat = fstatSync(owner.fd, { bigint: true });
  } catch {
    throw collectionError("IO", "Linux workspace directory descriptor is unavailable");
  }
  if (!stat.isDirectory()) {
    throw collectionError("NOT_DIRECTORY", "workspace path component is not a directory");
  }
  if (stat.nlink <= 0n) {
    throw collectionError("UNLINKED", "workspace directory is no longer linked");
  }
}

function openRoot(ledger: FdLedger): OwnedFd {
  let owner: OwnedFd;
  try {
    owner = ledger.open("/", FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch {
    throw collectionError("PATH_OPEN_FAILED", "workspace root could not be opened");
  }
  validateOpenDirectory(owner);
  return owner;
}

function openChild(ledger: FdLedger, parent: OwnedFd, component: string): OwnedFd {
  let owner: OwnedFd;
  try {
    owner = ledger.open(
      `/proc/self/fd/${parent.fd}/${component}`,
      FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | FS.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrno(error, "ELOOP", "ENOTDIR")) {
      throw collectionError(
        "PATH_COMPONENT_REFUSED",
        "workspace path component was refused without following it",
      );
    }
    throw collectionError("PATH_OPEN_FAILED", "workspace path component could not be opened");
  }
  validateOpenDirectory(owner);
  return owner;
}

function retainChain(
  ledger: FdLedger,
  root: OwnedFd,
  components: readonly string[],
): RetainedChain {
  const guardians: OwnedFd[] = [root];
  let parent = root;
  for (const component of components) {
    const child = openChild(ledger, parent, component);
    guardians.push(child);
    parent = child;
  }
  return Object.freeze({ guardians: Object.freeze(guardians), components });
}

function sampleDirectory(ledger: FdLedger, owner: OwnedFd): DirectoryFact {
  let stat: BigIntStats;
  try {
    stat = fstatSync(owner.fd, { bigint: true });
  } catch {
    throw collectionError("IO", "workspace directory descriptor is unavailable");
  }
  if (!stat.isDirectory()) {
    throw collectionError("NOT_DIRECTORY", "workspace descriptor is not a directory");
  }
  if (stat.nlink <= 0n) {
    throw collectionError("UNLINKED", "workspace directory is no longer linked");
  }
  const linkedStat = descriptorStat(owner.fd, "FILESYSTEM_INVALID");
  if (linkedStat.dev !== stat.dev || linkedStat.ino !== stat.ino) {
    throw collectionError("FD_IDENTITY_MISMATCH", "workspace descriptor identity changed");
  }
  const filesystemMagic = statfsType(`/proc/self/fd/${owner.fd}`, "FILESYSTEM_INVALID");
  if (filesystemMagic <= 0n) {
    throw collectionError("FILESYSTEM_INVALID", "workspace filesystem identity is invalid");
  }
  return Object.freeze({
    device: requireU64(stat.dev, true, "FILESYSTEM_INVALID"),
    inode: requireU64(stat.ino, false, "FILESYSTEM_INVALID"),
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    mountId: readMountId(ledger, owner.fd),
    filesystemMagic,
  });
}

function sameDirectoryFact(left: DirectoryFact, right: DirectoryFact): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mountId === right.mountId &&
    left.filesystemMagic === right.filesystemMagic
  );
}

function requireSameFacts(
  left: readonly DirectoryFact[],
  right: readonly DirectoryFact[],
  exactLength: boolean,
): void {
  if ((exactLength && left.length !== right.length) || left.length > right.length) {
    throw collectionError("CHANGED", "workspace selector identity changed during observation");
  }
  for (let index = 0; index < left.length; index++) {
    const leftFact = left[index];
    const rightFact = right[index];
    if (
      leftFact === undefined ||
      rightFact === undefined ||
      !sameDirectoryFact(leftFact, rightFact)
    ) {
      throw collectionError("CHANGED", "workspace selector identity changed during observation");
    }
  }
}

function sweepChains(
  ledger: FdLedger,
  sharedRoot: OwnedFd,
  allowedRoot: RetainedChain,
  target: RetainedChain,
): DirectorySweep {
  const rootFact = sampleDirectory(ledger, sharedRoot);
  const allowedFacts = [
    rootFact,
    ...allowedRoot.guardians.slice(1).map((owner) => sampleDirectory(ledger, owner)),
  ];
  const targetFacts = [
    rootFact,
    ...target.guardians.slice(1).map((owner) => sampleDirectory(ledger, owner)),
  ];
  requireSameFacts(allowedFacts, targetFacts, false);
  return Object.freeze({
    allowedRoot: Object.freeze(allowedFacts),
    target: Object.freeze(targetFacts),
  });
}

function freshStreamedWalk(
  ledger: FdLedger,
  components: readonly string[],
): readonly DirectoryFact[] {
  let current = openRoot(ledger);
  const facts: DirectoryFact[] = [sampleDirectory(ledger, current)];
  for (const component of components) {
    const child = openChild(ledger, current, component);
    const fact = sampleDirectory(ledger, child);
    // Mark-before-close makes numeric reuse safe even if close releases the FD and then reports error.
    ledger.close(current);
    current = child;
    facts.push(fact);
  }
  ledger.close(current);
  return Object.freeze(facts);
}

function requireSameNamespace(left: NamespaceFact, right: NamespaceFact): void {
  if (
    left.device !== right.device ||
    left.inode !== right.inode ||
    left.filesystemMagic !== right.filesystemMagic
  ) {
    throw collectionError("CHANGED", "Linux mount namespace changed during observation");
  }
}

function freezeObservation(
  bootId: string,
  namespace: NamespaceFact,
  sweep: DirectorySweep,
): WorkspaceObservation {
  return Object.freeze({
    bootId,
    namespace,
    allowedRootFacts: sweep.allowedRoot,
    targetFacts: sweep.target,
  });
}

function performSynchronousObservation(
  input: ParsedCollectionInput,
  ledger: FdLedger,
): WorkspaceObservation {
  assertPlatform();
  assertProcfs();
  const firstBootId = openBootId(ledger);
  const firstNamespace = openNamespace(ledger);

  const sharedRoot = openRoot(ledger);
  const allowedRoot = retainChain(ledger, sharedRoot, input.allowedRoot.components);
  // Deliberately restart from the same root; never reuse allowed-root prefix descriptors.
  const target = retainChain(ledger, sharedRoot, input.canonicalDirectory.components);

  const firstSweep = sweepChains(ledger, sharedRoot, allowedRoot, target);
  const secondSweep = sweepChains(ledger, sharedRoot, allowedRoot, target);
  requireSameFacts(firstSweep.allowedRoot, secondSweep.allowedRoot, true);
  requireSameFacts(firstSweep.target, secondSweep.target, true);

  const freshAllowedRoot = freshStreamedWalk(ledger, input.allowedRoot.components);
  requireSameFacts(secondSweep.allowedRoot, freshAllowedRoot, true);
  const freshTarget = freshStreamedWalk(ledger, input.canonicalDirectory.components);
  requireSameFacts(secondSweep.target, freshTarget, true);
  requireSameFacts(freshAllowedRoot, freshTarget, false);

  const allowedRootFinal = secondSweep.allowedRoot.at(-1);
  if (allowedRootFinal === undefined) {
    throw collectionError("IO", "workspace allowed-root identity is unavailable");
  }
  for (let index = secondSweep.allowedRoot.length; index < secondSweep.target.length; index++) {
    if (secondSweep.target[index]?.mountId !== allowedRootFinal.mountId) {
      throw collectionError(
        "MOUNT_CROSSING",
        "workspace target crosses a mount below the configured allowed root",
      );
    }
  }

  const secondNamespace = openNamespace(ledger);
  const secondBootId = openBootId(ledger);
  if (firstBootId !== secondBootId) {
    throw collectionError("CHANGED", "Linux boot identity changed during observation");
  }
  requireSameNamespace(firstNamespace.fact, secondNamespace.fact);
  return freezeObservation(firstBootId, firstNamespace.fact, secondSweep);
}

function observeLinuxWorkspace(input: ParsedCollectionInput): WorkspaceObservation {
  const ledger = new FdLedger();
  let result: WorkspaceObservation | undefined;
  let failure: LinuxWorkspaceCollectionError | undefined;
  try {
    result = performSynchronousObservation(input, ledger);
  } catch (error) {
    failure = normalizeObservationFailure(error);
  }
  const cleanupFailure = ledger.cleanup();
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (result === undefined) {
    throw collectionError("IO", "Linux workspace evidence observation produced no result");
  }
  return result;
}

function ancestryEntry(
  index: number,
  component: string,
  fact: DirectoryFact,
): LinuxAllowedRootAncestryEntryV1 {
  return Object.freeze({
    index,
    component,
    directoryDevice: u64DecimalFromBigInt(fact.device, "workspaceAncestry.directoryDevice"),
    directoryInode: u64DecimalFromBigInt(fact.inode, "workspaceAncestry.directoryInode"),
    mountId: u64DecimalFromBigInt(fact.mountId, "workspaceAncestry.mountId"),
    filesystemMagic: u64DecimalFromBigInt(
      fact.filesystemMagic,
      "workspaceAncestry.filesystemMagic",
    ),
  });
}

function ancestryEntries(
  components: readonly string[],
  facts: readonly DirectoryFact[],
): readonly LinuxAllowedRootAncestryEntryV1[] {
  if (facts.length !== components.length + 1) {
    throw collectionError("CANONICALIZATION_FAILED", "workspace ancestry is incomplete");
  }
  return Object.freeze(
    facts.map((fact, index) =>
      ancestryEntry(index, index === 0 ? "/" : (components[index - 1] ?? ""), fact),
    ),
  );
}

async function buildCanonicalArtifacts(
  input: ParsedCollectionInput,
  observation: WorkspaceObservation,
): Promise<CollectedLinuxWorkspaceEvidence> {
  try {
    const mountNamespace = await canonicalLinuxMountNamespaceIdentityArtifact({
      schemaId: LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
      schemaVersion: 1,
      runtimeId: input.runtimeId,
      nativeIncarnation: input.nativeIncarnation,
      namespaceKind: LINUX_MOUNT_NAMESPACE_KIND,
      bootId: observation.bootId,
      namespaceDevice: u64DecimalFromBigInt(
        observation.namespace.device,
        "linuxMountNamespaceIdentity.namespaceDevice",
      ),
      namespaceInode: u64DecimalFromBigInt(
        observation.namespace.inode,
        "linuxMountNamespaceIdentity.namespaceInode",
      ),
      namespaceFilesystemMagic: LINUX_NSFS_MAGIC_DECIMAL,
    });

    const canonicalDirectoryPathDigestValue = await canonicalDirectoryPathDigest(
      input.canonicalDirectory.path,
    );
    const canonicalDirectory = await canonicalPosixCanonicalDirectoryEvidenceArtifact({
      schemaId: POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID,
      schemaVersion: 1,
      runtimeId: input.runtimeId,
      nativeIncarnation: input.nativeIncarnation,
      directoryNormalizationSchemaId: NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
      mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
      canonicalDirectory: input.canonicalDirectory.path,
      canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
    });

    const targetFinal = observation.targetFacts.at(-1);
    if (targetFinal === undefined) {
      throw collectionError("CANONICALIZATION_FAILED", "workspace target identity is unavailable");
    }
    const filesystemIdentity = await canonicalLinuxNoFollowFilesystemIdentityArtifact({
      schemaId: LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID,
      schemaVersion: 1,
      runtimeId: input.runtimeId,
      nativeIncarnation: input.nativeIncarnation,
      mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
      canonicalDirectoryArtifactDigest: canonicalDirectory.commitment.artifactDigest,
      canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
      fileKind: LINUX_DIRECTORY_FILE_KIND,
      directoryDevice: u64DecimalFromBigInt(
        targetFinal.device,
        "linuxNoFollowFilesystemIdentity.directoryDevice",
      ),
      directoryInode: u64DecimalFromBigInt(
        targetFinal.inode,
        "linuxNoFollowFilesystemIdentity.directoryInode",
      ),
      mountId: u64DecimalFromBigInt(targetFinal.mountId, "linuxNoFollowFilesystemIdentity.mountId"),
      filesystemMagic: u64DecimalFromBigInt(
        targetFinal.filesystemMagic,
        "linuxNoFollowFilesystemIdentity.filesystemMagic",
      ),
    });

    const allowedRootPathDigest = await canonicalDirectoryPathDigest(input.allowedRoot.path);
    const allowedRoot = await canonicalLinuxAllowedRootAncestryArtifact({
      schemaId: LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID,
      schemaVersion: 1,
      runtimeId: input.runtimeId,
      nativeIncarnation: input.nativeIncarnation,
      mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
      canonicalDirectoryArtifactDigest: canonicalDirectory.commitment.artifactDigest,
      filesystemIdentityArtifactDigest: filesystemIdentity.commitment.artifactDigest,
      suffixMountPolicy: LINUX_ALLOWED_ROOT_SUFFIX_MOUNT_POLICY,
      allowedRoot: input.allowedRoot.path,
      allowedRootPathDigest,
      canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
      allowedRootEntryCount: observation.allowedRootFacts.length,
      allowedRootEntries: ancestryEntries(
        input.allowedRoot.components,
        observation.allowedRootFacts,
      ),
      targetEntryCount: observation.targetFacts.length,
      targetEntries: ancestryEntries(input.canonicalDirectory.components, observation.targetFacts),
    });

    const collected: CollectedLinuxWorkspaceEvidenceShape = {
      mountNamespace,
      canonicalDirectory,
      filesystemIdentity,
      allowedRoot,
    };
    return Object.freeze(collected) as CollectedLinuxWorkspaceEvidence;
  } catch (error) {
    if (LinuxWorkspaceCollectionError.is(error)) throw error;
    throw collectionError(
      "CANONICALIZATION_FAILED",
      "Linux workspace observation could not be canonically encoded",
    );
  }
}

/**
 * Observe one allowed-root-contained Linux directory. Every filesystem and procfs operation runs
 * synchronously before the first await; all descriptors are closed before canonical hashing begins.
 */
export async function collectLinuxWorkspaceEvidence(
  input: CollectLinuxWorkspaceEvidenceInput,
): Promise<CollectedLinuxWorkspaceEvidence> {
  const parsed = parseCollectionInput(input);
  const observation = observeLinuxWorkspace(parsed);
  return buildCanonicalArtifacts(parsed, observation);
}
