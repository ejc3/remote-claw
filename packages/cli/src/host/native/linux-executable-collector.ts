import { createHash } from "node:crypto";
import { type BigIntStats, constants as FS } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { base64urlEncode } from "@remote-claw/clawsec";
import { parseA1Digest } from "../state/ids.js";
import {
  type CanonicalExecutableManifestArtifact,
  canonicalExecutableManifestArtifact,
  EXECUTABLE_DIGEST_ALGORITHM,
  EXECUTABLE_MANIFEST_ROLES,
  EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE,
  type ExecutableChunkDigestV1,
  type ExecutableManifestRole,
  executableChunkDigest,
  executableChunkVectorDigest,
  FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID,
  MAX_EXECUTABLE_BYTES,
  NOMINAL_EXECUTABLE_CHUNK_BYTES,
} from "../state/native-binding-authority-executable-evidence.js";

export type LinuxExecutableCollectionErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_PATH"
  | "INVALID_ROLE"
  | "OPEN_FAILED"
  | "SYMLINK_REFUSED"
  | "NOT_REGULAR"
  | "UNLINKED"
  | "EMPTY"
  | "NOT_EXECUTABLE"
  | "TOO_LARGE"
  | "TRUNCATED"
  | "GREW"
  | "CHANGED"
  | "IO";

export class LinuxExecutableCollectionError extends Error {
  readonly code: LinuxExecutableCollectionErrorCode;

  constructor(code: LinuxExecutableCollectionErrorCode, message: string) {
    super(message);
    this.name = "LinuxExecutableCollectionError";
    this.code = code;
  }

  static is(value: unknown): value is LinuxExecutableCollectionError {
    return value instanceof LinuxExecutableCollectionError;
  }
}

export interface CollectLinuxExecutableEvidenceOptions {
  readonly signal?: AbortSignal;
}

const COLLECTED_EXECUTABLE_CONTENT_MANIFEST: unique symbol = Symbol(
  "CollectedExecutableContentManifest",
);

/**
 * Compile-time nominal result produced after the stable-FD collector completes both exact passes.
 * The symbol is not runtime authenticity: later authority code must reparse/recompute the bytes and
 * may only obtain this value by directly invoking its trusted collector boundary.
 */
export type CollectedExecutableContentManifest<Role extends ExecutableManifestRole> =
  CanonicalExecutableManifestArtifact<Role> &
    Readonly<{ [COLLECTED_EXECUTABLE_CONTENT_MANIFEST]: true }>;

type StableExecutableStat = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type CollectedPass = Readonly<{
  rawFileSha256: ReturnType<typeof parseA1Digest>;
  chunks: readonly ExecutableChunkDigestV1[];
}>;

function collectorError(
  code: LinuxExecutableCollectionErrorCode,
  message: string,
): LinuxExecutableCollectionError {
  return new LinuxExecutableCollectionError(code, message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The executable evidence collection was aborted", "AbortError");
  }
}

function validateRole(value: unknown): asserts value is ExecutableManifestRole {
  if (
    typeof value !== "string" ||
    !(EXECUTABLE_MANIFEST_ROLES as readonly string[]).includes(value)
  ) {
    throw collectorError("INVALID_ROLE", "executable evidence role is not selected");
  }
}

function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    (value as { readonly name?: unknown }).name === "AbortError"
  );
}

function normalizeCollectionFailure(value: unknown): unknown {
  if (LinuxExecutableCollectionError.is(value) || isAbortError(value)) return value;
  return collectorError("IO", "could not read executable evidence source");
}

function executableStat(stat: BigIntStats): StableExecutableStat {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameStat(left: StableExecutableStat, right: StableExecutableStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validateInitialStat(stat: BigIntStats): StableExecutableStat {
  if (!stat.isFile()) {
    throw collectorError("NOT_REGULAR", "executable evidence source is not a regular file");
  }
  if (stat.nlink <= 0n) {
    throw collectorError("UNLINKED", "executable evidence source is no longer linked");
  }
  if (stat.size === 0n) {
    throw collectorError("EMPTY", "executable evidence source is empty");
  }
  if (stat.size > BigInt(MAX_EXECUTABLE_BYTES)) {
    throw collectorError(
      "TOO_LARGE",
      `executable evidence source exceeds ${MAX_EXECUTABLE_BYTES} bytes`,
    );
  }
  if ((stat.mode & 0o111n) === 0n) {
    throw collectorError("NOT_EXECUTABLE", "executable evidence source has no execute bit");
  }
  return executableStat(stat);
}

async function exactPositionalRead(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  let filled = 0;
  while (filled < buffer.byteLength) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.byteLength - filled,
      position + filled,
    );
    throwIfAborted(signal);
    if (bytesRead === 0) {
      throw collectorError("TRUNCATED", "executable evidence source truncated during collection");
    }
    filled += bytesRead;
  }
}

async function requireEof(
  handle: FileHandle,
  fileByteLength: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const probe = Buffer.alloc(1);
  const { bytesRead } = await handle.read(probe, 0, 1, fileByteLength);
  throwIfAborted(signal);
  if (bytesRead !== 0) {
    throw collectorError("GREW", "executable evidence source grew during collection");
  }
}

async function collectPass(
  handle: FileHandle,
  role: ExecutableManifestRole,
  fileByteLength: number,
  signal: AbortSignal | undefined,
): Promise<CollectedPass> {
  const rawDigest = createHash("sha256");
  const chunks: ExecutableChunkDigestV1[] = [];
  const chunkCount = Math.ceil(fileByteLength / NOMINAL_EXECUTABLE_CHUNK_BYTES);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    throwIfAborted(signal);
    const byteOffset = chunkIndex * NOMINAL_EXECUTABLE_CHUNK_BYTES;
    const byteLength = Math.min(NOMINAL_EXECUTABLE_CHUNK_BYTES, fileByteLength - byteOffset);
    const chunkBytes = Buffer.allocUnsafe(byteLength);
    await exactPositionalRead(handle, chunkBytes, byteOffset, signal);
    rawDigest.update(chunkBytes);
    const digest = await executableChunkDigest({
      role,
      fileByteLength,
      chunkIndex,
      byteOffset,
      chunkBytes,
    });
    chunks.push(Object.freeze({ chunkIndex, byteOffset, byteLength, chunkDigest: digest }));
  }
  await requireEof(handle, fileByteLength, signal);
  return Object.freeze({
    rawFileSha256: parseA1Digest(base64urlEncode(rawDigest.digest())),
    chunks: Object.freeze(chunks),
  });
}

function samePass(left: CollectedPass, right: CollectedPass): boolean {
  if (left.rawFileSha256 !== right.rawFileSha256 || left.chunks.length !== right.chunks.length) {
    return false;
  }
  return left.chunks.every((chunk, index) => {
    const other = right.chunks[index];
    return (
      other !== undefined &&
      chunk.chunkIndex === other.chunkIndex &&
      chunk.byteOffset === other.byteOffset &&
      chunk.byteLength === other.byteLength &&
      chunk.chunkDigest === other.chunkDigest
    );
  });
}

async function collectFromOpenHandle<Role extends ExecutableManifestRole>(
  handle: FileHandle,
  role: Role,
  signal: AbortSignal | undefined,
): Promise<CollectedExecutableContentManifest<Role>> {
  throwIfAborted(signal);
  const initialRawStat = await handle.stat({ bigint: true });
  throwIfAborted(signal);
  const initialStat = validateInitialStat(initialRawStat);
  const fileByteLength = Number(initialStat.size);

  const first = await collectPass(handle, role, fileByteLength, signal);
  const middleStat = executableStat(await handle.stat({ bigint: true }));
  if (!sameStat(initialStat, middleStat)) {
    throw collectorError("CHANGED", "executable evidence source changed during collection");
  }

  // Give cancellation and concurrent mutation a scheduling point between the two complete reads.
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
  const second = await collectPass(handle, role, fileByteLength, signal);
  const finalStat = executableStat(await handle.stat({ bigint: true }));
  throwIfAborted(signal);
  if (!sameStat(initialStat, finalStat) || !samePass(first, second)) {
    throw collectorError("CHANGED", "executable evidence source changed during collection");
  }

  const chunkVectorDigest = await executableChunkVectorDigest(role, fileByteLength, second.chunks);
  throwIfAborted(signal);
  const artifact = await canonicalExecutableManifestArtifact(
    {
      schemaId: EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE[role],
      schemaVersion: 1,
      chunkingSchemaId: FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID,
      digestAlgorithm: EXECUTABLE_DIGEST_ALGORITHM,
      nominalChunkBytes: NOMINAL_EXECUTABLE_CHUNK_BYTES,
      fileByteLength,
      rawFileSha256: second.rawFileSha256,
      chunkCount: second.chunks.length,
      chunks: second.chunks,
      chunkVectorDigest,
    },
    role,
  );
  throwIfAborted(signal);
  const collected: CanonicalExecutableManifestArtifact<Role> = {
    canonicalBytes: artifact.canonicalBytes,
    manifest: artifact.manifest,
    commitment: artifact.commitment,
  };
  Object.defineProperty(collected, COLLECTED_EXECUTABLE_CONTENT_MANIFEST, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return Object.freeze(collected) as CollectedExecutableContentManifest<Role>;
}

/**
 * Measure one Linux executable without ever reopening or following its final path component.
 * The returned E1a commitment is derived from the verified canonical manifest bytes only.
 */
export async function collectLinuxExecutableEvidence<Role extends ExecutableManifestRole>(
  path: string,
  role: Role,
  options: CollectLinuxExecutableEvidenceOptions = {},
): Promise<CollectedExecutableContentManifest<Role>> {
  if (
    process.platform !== "linux" ||
    typeof FS.O_NOFOLLOW !== "number" ||
    typeof FS.O_NONBLOCK !== "number"
  ) {
    throw collectorError(
      "UNSUPPORTED_PLATFORM",
      "executable evidence collection requires Linux O_NOFOLLOW and O_NONBLOCK",
    );
  }
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw collectorError(
      "INVALID_PATH",
      "executable evidence path must be a nonempty NUL-free string",
    );
  }
  validateRole(role);
  throwIfAborted(options.signal);

  let handle: FileHandle;
  try {
    handle = await open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw collectorError("SYMLINK_REFUSED", "refusing to follow executable evidence symlink");
    }
    throw collectorError("OPEN_FAILED", "could not open executable evidence source");
  }

  let result: CollectedExecutableContentManifest<Role> | undefined;
  let failure: unknown;
  try {
    result = await collectFromOpenHandle(handle, role, options.signal);
  } catch (error) {
    failure = normalizeCollectionFailure(error);
  }
  try {
    await handle.close();
  } catch {
    if (failure === undefined) {
      failure = collectorError("IO", "could not close executable evidence source");
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) {
    throw collectorError("IO", "executable evidence collection produced no result");
  }
  return result;
}
