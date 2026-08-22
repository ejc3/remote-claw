import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  canonicalByteLength,
  canonicalByteSnapshot,
  sha256,
  timingSafeEqual,
} from "@remote-claw/clawsec";
import { type A1Digest, HostStateContractError, parseA1Digest } from "./ids.js";
import {
  type NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS,
  type NativeEvidenceArtifactCommitmentV1,
  nativeBindingAuthorityArtifactDigest,
  parseNativeEvidenceArtifactCommitment,
} from "./native-binding-authority-evidence.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
  snapshotExactArray,
} from "./validation.js";

export const NATIVE_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID =
  "remote-claw/native-executable-chunk-manifest/v1" as const;
export const FRONT_DOOR_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID =
  "remote-claw/front-door-executable-chunk-manifest/v1" as const;
export const FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID =
  "remote-claw/fixed-executable-chunking/v1" as const;
export const EXECUTABLE_CHUNK_DIGEST_DOMAIN = "remote-claw/executable-chunk/v1" as const;
export const EXECUTABLE_CHUNK_VECTOR_DIGEST_DOMAIN =
  "remote-claw/executable-chunk-vector/v1" as const;
export const EXECUTABLE_DIGEST_ALGORITHM = "SHA-256" as const;

export const NOMINAL_EXECUTABLE_CHUNK_BYTES = 1_048_576;
export const MAX_EXECUTABLE_BYTES = 268_435_456;
export const MAX_EXECUTABLE_CHUNKS = 256;
export const MAX_EXECUTABLE_MANIFEST_BYTES = 65_536;

export const EXECUTABLE_MANIFEST_ROLES = Object.freeze([
  "listener.native_executable",
  "listener.front_door_executable",
] as const);

export type ExecutableManifestRole = (typeof EXECUTABLE_MANIFEST_ROLES)[number];

export const EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE = Object.freeze({
  "listener.native_executable": NATIVE_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID,
  "listener.front_door_executable": FRONT_DOOR_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID,
} as const satisfies Readonly<Record<ExecutableManifestRole, string>>);

export type ExecutableManifestSchemaId =
  (typeof EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE)[ExecutableManifestRole];

type ExecutableManifestSchemaForRole<Role extends ExecutableManifestRole> =
  (typeof EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE)[Role];

export interface ExecutableChunkDigestV1 {
  readonly chunkIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly chunkDigest: A1Digest;
}

export interface ExecutableChunkManifestV1<Role extends ExecutableManifestRole> {
  readonly schemaId: ExecutableManifestSchemaForRole<Role>;
  readonly schemaVersion: 1;
  readonly chunkingSchemaId: typeof FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID;
  readonly digestAlgorithm: typeof EXECUTABLE_DIGEST_ALGORITHM;
  readonly nominalChunkBytes: typeof NOMINAL_EXECUTABLE_CHUNK_BYTES;
  readonly fileByteLength: number;
  readonly rawFileSha256: A1Digest;
  readonly chunkCount: number;
  readonly chunks: readonly ExecutableChunkDigestV1[];
  readonly chunkVectorDigest: A1Digest;
}

export type AnyExecutableChunkManifestV1 = ExecutableChunkManifestV1<ExecutableManifestRole>;

/**
 * A syntactically canonical manifest artifact. This type proves canonical structure and its
 * self-contained chunk-vector digest, but deliberately does not prove that any file was measured.
 */
export interface CanonicalExecutableManifestArtifact<Role extends ExecutableManifestRole> {
  readonly canonicalBytes: ProtectedByteSnapshot;
  readonly manifest: ExecutableChunkManifestV1<Role>;
  readonly commitment: NativeEvidenceArtifactCommitmentV1<Role>;
}

const MANIFEST_KEYS = [
  "schemaId",
  "schemaVersion",
  "chunkingSchemaId",
  "digestAlgorithm",
  "nominalChunkBytes",
  "fileByteLength",
  "rawFileSha256",
  "chunkCount",
  "chunks",
  "chunkVectorDigest",
] as const;

const CHUNK_KEYS = ["chunkIndex", "byteOffset", "byteLength", "chunkDigest"] as const;

function reject(field: string, requirement: string): never {
  throw new HostStateContractError(`${field} ${requirement}`);
}

function parseRole(value: unknown, field: string): ExecutableManifestRole {
  return parseEnum(value, EXECUTABLE_MANIFEST_ROLES, field);
}

function parseFileByteLength(value: unknown, field: string): number {
  const parsed = parsePositiveSafeInteger(value, field);
  if (parsed > MAX_EXECUTABLE_BYTES) {
    reject(field, `must be at most ${MAX_EXECUTABLE_BYTES}`);
  }
  return parsed;
}

function expectedChunkCount(fileByteLength: number): number {
  return Math.ceil(fileByteLength / NOMINAL_EXECUTABLE_CHUNK_BYTES);
}

function expectedChunkLength(fileByteLength: number, chunkIndex: number): number {
  return Math.min(
    NOMINAL_EXECUTABLE_CHUNK_BYTES,
    fileByteLength - chunkIndex * NOMINAL_EXECUTABLE_CHUNK_BYTES,
  );
}

function parseChunks(value: unknown, fileByteLength: number): readonly ExecutableChunkDigestV1[] {
  const count = expectedChunkCount(fileByteLength);
  if (count > MAX_EXECUTABLE_CHUNKS) {
    reject("executableChunkManifest.chunks", `must contain exactly ${count} chunks`);
  }
  const candidates = snapshotExactArray(value, count, "executableChunkManifest.chunks");
  return Object.freeze(
    candidates.map((candidate, index) => {
      const field = `executableChunkManifest.chunks[${index}]`;
      const row = parseExactRecord(candidate, CHUNK_KEYS, field);
      const chunkIndex = parseNonNegativeSafeInteger(row.chunkIndex, `${field}.chunkIndex`);
      const byteOffset = parseNonNegativeSafeInteger(row.byteOffset, `${field}.byteOffset`);
      const byteLength = parsePositiveSafeInteger(row.byteLength, `${field}.byteLength`);
      const requiredOffset = index * NOMINAL_EXECUTABLE_CHUNK_BYTES;
      const requiredLength = expectedChunkLength(fileByteLength, index);
      if (chunkIndex !== index) reject(`${field}.chunkIndex`, `must equal ${index}`);
      if (byteOffset !== requiredOffset) {
        reject(`${field}.byteOffset`, `must equal ${requiredOffset}`);
      }
      if (byteLength !== requiredLength) {
        reject(`${field}.byteLength`, `must equal ${requiredLength}`);
      }
      return frozen({
        chunkIndex,
        byteOffset,
        byteLength,
        chunkDigest: parseA1Digest(row.chunkDigest, `${field}.chunkDigest`),
      });
    }),
  );
}

function writeChunkVectorPrefix(
  writer: CanonicalWriter,
  schemaId: ExecutableManifestSchemaId,
  fileByteLength: number,
  chunks: readonly ExecutableChunkDigestV1[],
): void {
  writer.str(EXECUTABLE_CHUNK_VECTOR_DIGEST_DOMAIN);
  writer.str(schemaId);
  writer.uint(1);
  writer.str(FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID);
  writer.str(EXECUTABLE_DIGEST_ALGORITHM);
  writer.uint(NOMINAL_EXECUTABLE_CHUNK_BYTES);
  writer.uint(fileByteLength);
  writer.uint(chunks.length);
  for (const chunk of chunks) {
    writer.uint(chunk.chunkIndex);
    writer.uint(chunk.byteOffset);
    writer.uint(chunk.byteLength);
    writer.bytes(base64urlDecode(chunk.chunkDigest));
  }
}

export async function executableChunkVectorDigest(
  role: ExecutableManifestRole,
  fileByteLength: number,
  chunks: readonly ExecutableChunkDigestV1[],
): Promise<A1Digest> {
  const parsedRole = parseRole(role, "executableChunkVector.role");
  const parsedLength = parseFileByteLength(fileByteLength, "executableChunkVector.fileByteLength");
  const parsedChunks = parseChunks(chunks, parsedLength);
  const writer = new CanonicalWriter();
  writeChunkVectorPrefix(
    writer,
    EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE[parsedRole],
    parsedLength,
    parsedChunks,
  );
  return parseA1Digest(base64urlEncode(await sha256(writer.finish())));
}

export interface ExecutableChunkDigestInput<Role extends ExecutableManifestRole> {
  readonly role: Role;
  readonly fileByteLength: number;
  readonly chunkIndex: number;
  readonly byteOffset: number;
  readonly chunkBytes: Uint8Array;
}

export async function executableChunkDigest<Role extends ExecutableManifestRole>(
  input: ExecutableChunkDigestInput<Role>,
): Promise<A1Digest> {
  const row = parseExactRecord(
    input,
    ["role", "fileByteLength", "chunkIndex", "byteOffset", "chunkBytes"],
    "executableChunk",
  );
  const role = parseRole(row.role, "executableChunk.role");
  const fileByteLength = parseFileByteLength(row.fileByteLength, "executableChunk.fileByteLength");
  const chunkIndex = parseNonNegativeSafeInteger(row.chunkIndex, "executableChunk.chunkIndex");
  const requiredCount = expectedChunkCount(fileByteLength);
  if (chunkIndex >= requiredCount) {
    reject("executableChunk.chunkIndex", `must be less than ${requiredCount}`);
  }
  const requiredOffset = chunkIndex * NOMINAL_EXECUTABLE_CHUNK_BYTES;
  const byteOffset = parseNonNegativeSafeInteger(row.byteOffset, "executableChunk.byteOffset");
  if (byteOffset !== requiredOffset) {
    reject("executableChunk.byteOffset", `must equal ${requiredOffset}`);
  }
  let sourceLength: number;
  try {
    sourceLength = canonicalByteLength(row.chunkBytes as Uint8Array);
  } catch {
    reject("executableChunk.chunkBytes", "must be a genuine Uint8Array");
  }
  const requiredLength = expectedChunkLength(fileByteLength, chunkIndex);
  if (sourceLength !== requiredLength) {
    reject("executableChunk.chunkBytes", `must contain exactly ${requiredLength} bytes`);
  }
  const chunkBytes = canonicalByteSnapshot(row.chunkBytes as Uint8Array);
  if (canonicalByteLength(chunkBytes) !== requiredLength) {
    reject("executableChunk.chunkBytes", `must contain exactly ${requiredLength} bytes`);
  }
  const writer = new CanonicalWriter();
  writer.str(EXECUTABLE_CHUNK_DIGEST_DOMAIN);
  writer.str(EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE[role]);
  writer.uint(1);
  writer.uint(fileByteLength);
  writer.uint(NOMINAL_EXECUTABLE_CHUNK_BYTES);
  writer.uint(chunkIndex);
  writer.uint(byteOffset);
  writer.bytes(chunkBytes);
  return parseA1Digest(base64urlEncode(await sha256(writer.finish())));
}

async function parseManifestForRole<Role extends ExecutableManifestRole>(
  value: unknown,
  expectedRole: Role,
): Promise<ExecutableChunkManifestV1<Role>> {
  const role = parseRole(expectedRole, "executableChunkManifest.role") as Role;
  const expectedSchemaId = EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE[role];
  const row = parseExactRecord(value, MANIFEST_KEYS, "executableChunkManifest");
  if (row.schemaId !== expectedSchemaId) {
    reject("executableChunkManifest.schemaId", `must equal ${expectedSchemaId}`);
  }
  if (row.schemaVersion !== 1) reject("executableChunkManifest.schemaVersion", "must equal 1");
  if (row.chunkingSchemaId !== FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID) {
    reject(
      "executableChunkManifest.chunkingSchemaId",
      `must equal ${FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID}`,
    );
  }
  if (row.digestAlgorithm !== EXECUTABLE_DIGEST_ALGORITHM) {
    reject("executableChunkManifest.digestAlgorithm", `must equal ${EXECUTABLE_DIGEST_ALGORITHM}`);
  }
  if (row.nominalChunkBytes !== NOMINAL_EXECUTABLE_CHUNK_BYTES) {
    reject(
      "executableChunkManifest.nominalChunkBytes",
      `must equal ${NOMINAL_EXECUTABLE_CHUNK_BYTES}`,
    );
  }
  const fileByteLength = parseFileByteLength(
    row.fileByteLength,
    "executableChunkManifest.fileByteLength",
  );
  const chunkCount = parsePositiveSafeInteger(row.chunkCount, "executableChunkManifest.chunkCount");
  const requiredChunkCount = expectedChunkCount(fileByteLength);
  if (chunkCount !== requiredChunkCount) {
    reject("executableChunkManifest.chunkCount", `must equal ${requiredChunkCount}`);
  }
  const chunks = parseChunks(row.chunks, fileByteLength);
  const chunkVectorDigest = parseA1Digest(
    row.chunkVectorDigest,
    "executableChunkManifest.chunkVectorDigest",
  );
  const expectedVectorDigest = await executableChunkVectorDigest(role, fileByteLength, chunks);
  if (chunkVectorDigest !== expectedVectorDigest) {
    reject("executableChunkManifest.chunkVectorDigest", "does not match the chunk vector");
  }
  return frozen({
    schemaId: expectedSchemaId,
    schemaVersion: 1,
    chunkingSchemaId: FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID,
    digestAlgorithm: EXECUTABLE_DIGEST_ALGORITHM,
    nominalChunkBytes: NOMINAL_EXECUTABLE_CHUNK_BYTES,
    fileByteLength,
    rawFileSha256: parseA1Digest(row.rawFileSha256, "executableChunkManifest.rawFileSha256"),
    chunkCount,
    chunks,
    chunkVectorDigest,
  }) as ExecutableChunkManifestV1<Role>;
}

export function parseExecutableChunkManifest<const Role extends ExecutableManifestRole>(
  value: unknown,
  expectedRole: Role,
): Promise<ExecutableChunkManifestV1<Role>> {
  return parseManifestForRole(value, expectedRole);
}

function encodeParsedManifest(manifest: AnyExecutableChunkManifestV1): Uint8Array<ArrayBuffer> {
  const writer = new CanonicalWriter();
  writer.str(manifest.schemaId);
  writer.uint(manifest.schemaVersion);
  writer.str(manifest.chunkingSchemaId);
  writer.str(manifest.digestAlgorithm);
  writer.uint(manifest.nominalChunkBytes);
  writer.uint(manifest.fileByteLength);
  writer.bytes(base64urlDecode(manifest.rawFileSha256));
  writer.uint(manifest.chunkCount);
  for (const chunk of manifest.chunks) {
    writer.uint(chunk.chunkIndex);
    writer.uint(chunk.byteOffset);
    writer.uint(chunk.byteLength);
    writer.bytes(base64urlDecode(chunk.chunkDigest));
  }
  writer.bytes(base64urlDecode(manifest.chunkVectorDigest));
  const bytes = canonicalByteSnapshot(writer.finish());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EXECUTABLE_MANIFEST_BYTES) {
    reject(
      "executableChunkManifestBytes",
      `must contain 1..${MAX_EXECUTABLE_MANIFEST_BYTES} canonical bytes`,
    );
  }
  return bytes;
}

export async function encodeExecutableChunkManifest<Role extends ExecutableManifestRole>(
  value: unknown,
  expectedRole: Role,
): Promise<Uint8Array<ArrayBuffer>> {
  return encodeParsedManifest(await parseManifestForRole(value, expectedRole));
}

const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ENCODER = new TextEncoder();

class ManifestReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;
  #offset = 0;

  constructor(value: Uint8Array) {
    let sourceLength: number;
    try {
      sourceLength = canonicalByteLength(value);
    } catch {
      reject("executableChunkManifestBytes", "must be a genuine Uint8Array");
    }
    if (sourceLength === 0 || sourceLength > MAX_EXECUTABLE_MANIFEST_BYTES) {
      reject(
        "executableChunkManifestBytes",
        `must contain 1..${MAX_EXECUTABLE_MANIFEST_BYTES} canonical bytes`,
      );
    }
    this.#bytes = canonicalByteSnapshot(value);
    if (this.#bytes.byteLength === 0 || this.#bytes.byteLength > MAX_EXECUTABLE_MANIFEST_BYTES) {
      reject(
        "executableChunkManifestBytes",
        `must contain 1..${MAX_EXECUTABLE_MANIFEST_BYTES} canonical bytes`,
      );
    }
  }

  #raw(length: number, field: string): Uint8Array<ArrayBuffer> {
    if (length < 0 || length > this.#bytes.byteLength - this.#offset) {
      reject(field, "is truncated");
    }
    const result = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  bytes(field: string, exactLength?: number): Uint8Array<ArrayBuffer> {
    const prefix = this.#raw(4, `${field}.length`);
    const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(
      0,
      false,
    );
    if (exactLength !== undefined && length !== exactLength) {
      reject(field, `must contain exactly ${exactLength} bytes`);
    }
    return this.#raw(length, field);
  }

  str(field: string): string {
    const bytes = this.bytes(field);
    let result: string;
    try {
      result = DECODER.decode(bytes);
    } catch {
      reject(field, "must contain canonical UTF-8");
    }
    const roundTrip = ENCODER.encode(result);
    if (
      roundTrip.byteLength !== bytes.byteLength ||
      roundTrip.some((byte, index) => byte !== bytes[index])
    ) {
      reject(field, "must contain canonical UTF-8");
    }
    return result;
  }

  uint(field: string): number {
    const bytes = this.bytes(field, 8);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
      0,
      false,
    );
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) reject(field, "must be a safe integer");
    return Number(value);
  }

  snapshot(): Uint8Array<ArrayBuffer> {
    return canonicalByteSnapshot(this.#bytes);
  }

  finish(): void {
    if (this.#offset !== this.#bytes.byteLength) {
      reject("executableChunkManifestBytes", "must not contain trailing bytes");
    }
  }
}

export async function decodeExecutableChunkManifest<Role extends ExecutableManifestRole>(
  value: Uint8Array,
  expectedRole: Role,
): Promise<ExecutableChunkManifestV1<Role>> {
  const reader = new ManifestReader(value);
  const source = reader.snapshot();
  const schemaId = reader.str("executableChunkManifest.schemaId");
  const schemaVersion = reader.uint("executableChunkManifest.schemaVersion");
  const chunkingSchemaId = reader.str("executableChunkManifest.chunkingSchemaId");
  const digestAlgorithm = reader.str("executableChunkManifest.digestAlgorithm");
  const nominalChunkBytes = reader.uint("executableChunkManifest.nominalChunkBytes");
  const fileByteLength = reader.uint("executableChunkManifest.fileByteLength");
  const rawFileSha256 = base64urlEncode(reader.bytes("executableChunkManifest.rawFileSha256", 32));
  const chunkCount = reader.uint("executableChunkManifest.chunkCount");
  if (chunkCount > MAX_EXECUTABLE_CHUNKS) {
    reject("executableChunkManifest.chunkCount", `must be at most ${MAX_EXECUTABLE_CHUNKS}`);
  }
  const chunks: ExecutableChunkDigestV1[] = [];
  for (let index = 0; index < chunkCount; index++) {
    chunks.push({
      chunkIndex: reader.uint(`executableChunkManifest.chunks[${index}].chunkIndex`),
      byteOffset: reader.uint(`executableChunkManifest.chunks[${index}].byteOffset`),
      byteLength: reader.uint(`executableChunkManifest.chunks[${index}].byteLength`),
      chunkDigest: parseA1Digest(
        base64urlEncode(reader.bytes(`executableChunkManifest.chunks[${index}].chunkDigest`, 32)),
      ),
    });
  }
  const chunkVectorDigest = base64urlEncode(
    reader.bytes("executableChunkManifest.chunkVectorDigest", 32),
  );
  reader.finish();
  const parsed = await parseManifestForRole(
    {
      schemaId,
      schemaVersion,
      chunkingSchemaId,
      digestAlgorithm,
      nominalChunkBytes,
      fileByteLength,
      rawFileSha256,
      chunkCount,
      chunks,
      chunkVectorDigest,
    },
    expectedRole,
  );
  const encoded = encodeParsedManifest(parsed);
  if (!timingSafeEqual(encoded, source)) {
    reject("executableChunkManifestBytes", "must use the exact canonical encoding");
  }
  return parsed;
}

export async function canonicalExecutableManifestArtifact<Role extends ExecutableManifestRole>(
  value: unknown,
  expectedRole: Role,
): Promise<CanonicalExecutableManifestArtifact<Role>> {
  const canonicalBytes = await encodeExecutableChunkManifest(value, expectedRole);
  const manifest = await decodeExecutableChunkManifest(canonicalBytes, expectedRole);
  const artifactDigest = await nativeBindingAuthorityArtifactDigest(canonicalBytes);
  const commitment = parseNativeEvidenceArtifactCommitment(
    {
      role: expectedRole,
      artifactSchemaId: manifest.schemaId,
      artifactDigest,
      byteLength: canonicalBytes.byteLength,
    },
    expectedRole,
  );
  return frozen({
    canonicalBytes: ProtectedByteSnapshot.from(canonicalBytes),
    manifest,
    commitment,
  });
}

// Compile-time closure: the implemented schema literals must stay identical to E1a's registry.
const _nativeManifestSchemaClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["listener.native_executable"]["artifactSchemaId"] =
  NATIVE_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID;
const _frontDoorManifestSchemaClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["listener.front_door_executable"]["artifactSchemaId"] =
  FRONT_DOOR_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID;
const _nativeManifestBoundClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["listener.native_executable"]["maxByteLength"] =
  MAX_EXECUTABLE_MANIFEST_BYTES;
const _frontDoorManifestBoundClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["listener.front_door_executable"]["maxByteLength"] =
  MAX_EXECUTABLE_MANIFEST_BYTES;
void _nativeManifestSchemaClosure;
void _frontDoorManifestSchemaClosure;
void _nativeManifestBoundClosure;
void _frontDoorManifestBoundClosure;
