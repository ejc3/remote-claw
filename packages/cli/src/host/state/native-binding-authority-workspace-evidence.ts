import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  canonicalByteLength,
  sha256,
  timingSafeEqual,
} from "@remote-claw/clawsec";
import {
  type A1Digest,
  type A1SafeId,
  HostStateContractError,
  type NativeRuntimeId,
  parseA1CanonicalId,
  parseA1Digest,
} from "./ids.js";
import {
  decodeNativeWorkspaceBindingInput,
  encodeNativeWorkspaceBindingInput,
  MAX_NATIVE_EVIDENCE_PARENT_BYTES,
  NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS,
  NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
  type NativeEvidenceArtifactCommitmentV1,
  type NativeWorkspaceBindingInputV1,
  nativeBindingAuthorityArtifactDigest,
  parseNativeEvidenceArtifactCommitment,
} from "./native-binding-authority-evidence.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  frozen,
  parseExactRecord,
  parsePositiveSafeInteger,
  snapshotExactArray,
} from "./validation.js";

export const LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID =
  "remote-claw/linux-mount-namespace-identity/v1" as const;
export const POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID =
  "remote-claw/posix-canonical-directory-evidence/v1" as const;
export const LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID =
  "remote-claw/linux-no-follow-filesystem-identity/v1" as const;
export const LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID =
  "remote-claw/linux-allowed-root-ancestry/v1" as const;
export const CANONICAL_DIRECTORY_PATH_DIGEST_DOMAIN =
  "remote-claw/canonical-directory-path/v1" as const;

export const LINUX_MOUNT_NAMESPACE_KIND = "mnt" as const;
export const LINUX_DIRECTORY_FILE_KIND = "directory" as const;
export const LINUX_ALLOWED_ROOT_SUFFIX_MOUNT_POLICY = "same_mount_as_allowed_root" as const;
export const LINUX_NSFS_MAGIC_DECIMAL = "1853056627" as U64Decimal;

export const MAX_POSIX_CANONICAL_DIRECTORY_EVIDENCE_BYTES = 16_384;
export const MAX_LINUX_FILESYSTEM_IDENTITY_EVIDENCE_BYTES = 65_536;
export const MAX_LINUX_MOUNT_NAMESPACE_IDENTITY_BYTES = 65_536;
export const MAX_LINUX_ALLOWED_ROOT_ANCESTRY_BYTES = 1_048_576;
export const MAX_WORKSPACE_PATH_UTF8_BYTES = 4_095;
export const MAX_WORKSPACE_PATH_COMPONENT_UTF8_BYTES = 255;
export const MAX_WORKSPACE_PATH_COMPONENTS = 256;
export const MAX_WORKSPACE_ANCESTRY_ENTRIES = MAX_WORKSPACE_PATH_COMPONENTS + 1;

const U64_MAX = 18_446_744_073_709_551_615n;
const U32_MAX = 4_294_967_295n;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ENCODER = new TextEncoder();
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")
  ?.get as (this: Uint8Array) => ArrayBufferLike;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get as (this: Uint8Array) => number;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

declare const u64DecimalBrand: unique symbol;
export type U64Decimal = string & { readonly [u64DecimalBrand]: true };

export interface ParsedPosixAbsoluteDirectory {
  readonly path: string;
  readonly components: readonly string[];
}

export interface LinuxMountNamespaceIdentityV1 {
  readonly schemaId: typeof LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly namespaceKind: typeof LINUX_MOUNT_NAMESPACE_KIND;
  readonly bootId: string;
  readonly namespaceDevice: U64Decimal;
  readonly namespaceInode: U64Decimal;
  readonly namespaceFilesystemMagic: typeof LINUX_NSFS_MAGIC_DECIMAL;
}

export interface PosixCanonicalDirectoryEvidenceV1 {
  readonly schemaId: typeof POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly directoryNormalizationSchemaId: typeof NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID;
  readonly mountNamespaceArtifactDigest: A1Digest;
  readonly canonicalDirectory: string;
  readonly canonicalDirectoryPathDigest: A1Digest;
}

export interface LinuxNoFollowFilesystemIdentityV1 {
  readonly schemaId: typeof LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly mountNamespaceArtifactDigest: A1Digest;
  readonly canonicalDirectoryArtifactDigest: A1Digest;
  readonly canonicalDirectoryPathDigest: A1Digest;
  readonly fileKind: typeof LINUX_DIRECTORY_FILE_KIND;
  readonly directoryDevice: U64Decimal;
  readonly directoryInode: U64Decimal;
  readonly mountId: U64Decimal;
  readonly filesystemMagic: U64Decimal;
}

export interface LinuxAllowedRootAncestryEntryV1 {
  readonly index: number;
  readonly component: string;
  readonly directoryDevice: U64Decimal;
  readonly directoryInode: U64Decimal;
  readonly mountId: U64Decimal;
  readonly filesystemMagic: U64Decimal;
}

export interface LinuxAllowedRootAncestryV1 {
  readonly schemaId: typeof LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly mountNamespaceArtifactDigest: A1Digest;
  readonly canonicalDirectoryArtifactDigest: A1Digest;
  readonly filesystemIdentityArtifactDigest: A1Digest;
  readonly suffixMountPolicy: typeof LINUX_ALLOWED_ROOT_SUFFIX_MOUNT_POLICY;
  readonly allowedRoot: string;
  readonly allowedRootPathDigest: A1Digest;
  readonly canonicalDirectoryPathDigest: A1Digest;
  readonly allowedRootEntryCount: number;
  readonly allowedRootEntries: readonly LinuxAllowedRootAncestryEntryV1[];
  readonly targetEntryCount: number;
  readonly targetEntries: readonly LinuxAllowedRootAncestryEntryV1[];
}

export type WorkspaceEvidenceRole =
  | "workspace.mount_namespace"
  | "workspace.canonical_directory"
  | "workspace.filesystem_identity"
  | "workspace.allowed_root";

export interface CanonicalWorkspaceEvidenceArtifact<Role extends WorkspaceEvidenceRole, Evidence> {
  readonly canonicalBytes: ProtectedByteSnapshot;
  readonly evidence: Evidence;
  readonly commitment: NativeEvidenceArtifactCommitmentV1<Role>;
}

export interface CanonicalWorkspaceParentArtifact {
  readonly canonicalBytes: ProtectedByteSnapshot;
  readonly input: NativeWorkspaceBindingInputV1;
  readonly commitment: NativeEvidenceArtifactCommitmentV1<"parent.workspace_input">;
}

export type NativeWorkspaceSlot =
  | Readonly<{ kind: "native_workspace_id"; value: A1SafeId }>
  | Readonly<{ kind: "canonical_directory_path_digest"; value: A1Digest }>;

export interface CanonicalWorkspaceEvidenceBundleInput {
  readonly mountNamespaceBytes: Uint8Array;
  readonly canonicalDirectoryBytes: Uint8Array;
  readonly filesystemIdentityBytes: Uint8Array;
  readonly allowedRootBytes: Uint8Array;
  readonly workspaceParentBytes: Uint8Array;
}

export interface CanonicalWorkspaceEvidenceBundle {
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
  readonly workspaceParent: CanonicalWorkspaceParentArtifact;
  readonly workspaceSlot: NativeWorkspaceSlot;
  readonly workspaceInputDigest: A1Digest;
}

const MOUNT_NAMESPACE_KEYS = [
  "schemaId",
  "schemaVersion",
  "runtimeId",
  "nativeIncarnation",
  "namespaceKind",
  "bootId",
  "namespaceDevice",
  "namespaceInode",
  "namespaceFilesystemMagic",
] as const;

const CANONICAL_DIRECTORY_KEYS = [
  "schemaId",
  "schemaVersion",
  "runtimeId",
  "nativeIncarnation",
  "directoryNormalizationSchemaId",
  "mountNamespaceArtifactDigest",
  "canonicalDirectory",
  "canonicalDirectoryPathDigest",
] as const;

const FILESYSTEM_IDENTITY_KEYS = [
  "schemaId",
  "schemaVersion",
  "runtimeId",
  "nativeIncarnation",
  "mountNamespaceArtifactDigest",
  "canonicalDirectoryArtifactDigest",
  "canonicalDirectoryPathDigest",
  "fileKind",
  "directoryDevice",
  "directoryInode",
  "mountId",
  "filesystemMagic",
] as const;

const ALLOWED_ROOT_KEYS = [
  "schemaId",
  "schemaVersion",
  "runtimeId",
  "nativeIncarnation",
  "mountNamespaceArtifactDigest",
  "canonicalDirectoryArtifactDigest",
  "filesystemIdentityArtifactDigest",
  "suffixMountPolicy",
  "allowedRoot",
  "allowedRootPathDigest",
  "canonicalDirectoryPathDigest",
  "allowedRootEntryCount",
  "allowedRootEntries",
  "targetEntryCount",
  "targetEntries",
] as const;

const ANCESTRY_ENTRY_KEYS = [
  "index",
  "component",
  "directoryDevice",
  "directoryInode",
  "mountId",
  "filesystemMagic",
] as const;

const BUNDLE_INPUT_KEYS = [
  "mountNamespaceBytes",
  "canonicalDirectoryBytes",
  "filesystemIdentityBytes",
  "allowedRootBytes",
  "workspaceParentBytes",
] as const;

function reject(field: string, requirement: string): never {
  throw new HostStateContractError(`${field} ${requirement}`);
}

/**
 * Snapshot an untrusted typed-array view without letting a concurrently grown length-tracking
 * SharedArrayBuffer view expand the allocation beyond the length that passed the public bound.
 */
function boundedByteSnapshot(value: unknown, maxBytes: number, field: string): Uint8Array {
  const source = value as Uint8Array;
  let initialLength: number;
  try {
    initialLength = canonicalByteLength(source);
  } catch {
    reject(field, "must be a genuine Uint8Array");
  }
  if (initialLength === 0 || initialLength > maxBytes) {
    reject(field, `must contain 1..${maxBytes} canonical bytes`);
  }

  let fixedSource: Uint8Array;
  try {
    const sourceBuffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, source, []) as ArrayBufferLike;
    const sourceByteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, source, []) as number;
    fixedSource = new Uint8Array(sourceBuffer, sourceByteOffset, initialLength);
    if (canonicalByteLength(fixedSource) !== initialLength) {
      reject(field, "changed while being snapshotted");
    }
  } catch (error) {
    if (error instanceof HostStateContractError) throw error;
    reject(field, "changed while being snapshotted");
  }

  const snapshot = new Uint8Array(initialLength);
  try {
    Reflect.apply(UINT8_ARRAY_SET, snapshot, [fixedSource, 0]);
  } catch {
    reject(field, "changed while being snapshotted");
  }
  let finalSourceLength: number;
  let finalFixedLength: number;
  try {
    finalSourceLength = canonicalByteLength(source);
    finalFixedLength = canonicalByteLength(fixedSource);
  } catch {
    reject(field, "changed while being snapshotted");
  }
  if (
    finalSourceLength !== initialLength ||
    finalFixedLength !== initialLength ||
    snapshot.byteLength !== initialLength
  ) {
    reject(field, "changed while being snapshotted");
  }
  return snapshot;
}

function requireLiteral<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) reject(field, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function assertUnicodeScalars(value: string, field: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) reject(field, "must not contain U+0000");
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        reject(field, "must contain only Unicode scalar values");
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      reject(field, "must contain only Unicode scalar values");
    }
  }
}

export function parseU64Decimal(value: unknown, field = "u64Decimal"): U64Decimal {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > U64_MAX
  ) {
    reject(field, "must be canonical unsigned 64-bit decimal");
  }
  return value as U64Decimal;
}

export function u64DecimalFromBigInt(value: bigint, field = "u64Decimal"): U64Decimal {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    reject(field, "must be an unsigned 64-bit bigint");
  }
  return value.toString(10) as U64Decimal;
}

function parsePositiveU64Decimal(value: unknown, field: string): U64Decimal {
  const parsed = parseU64Decimal(value, field);
  if (parsed === "0") reject(field, "must be greater than zero");
  return parsed;
}

function parseFilesystemMagic(value: unknown, field: string): U64Decimal {
  const parsed = parsePositiveU64Decimal(value, field);
  if (BigInt(parsed) > U32_MAX) reject(field, "must be an unsigned 32-bit value");
  return parsed;
}

function u64be(value: U64Decimal): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

export function parsePosixAbsoluteDirectory(
  value: unknown,
  field = "canonicalDirectory",
): ParsedPosixAbsoluteDirectory {
  if (typeof value !== "string") reject(field, "must be a string");
  assertUnicodeScalars(value, field);
  const byteLength = ENCODER.encode(value).byteLength;
  if (byteLength < 1 || byteLength > MAX_WORKSPACE_PATH_UTF8_BYTES) {
    reject(field, `must contain 1..${MAX_WORKSPACE_PATH_UTF8_BYTES} UTF-8 bytes`);
  }
  if (!value.startsWith("/")) reject(field, "must be an absolute POSIX path");
  if (value !== "/" && value.endsWith("/")) {
    reject(field, "must not have a trailing slash");
  }
  if (value.includes("//")) reject(field, "must not contain an empty component");
  const components = value === "/" ? [] : value.slice(1).split("/");
  if (components.length > MAX_WORKSPACE_PATH_COMPONENTS) {
    reject(field, `must contain at most ${MAX_WORKSPACE_PATH_COMPONENTS} components`);
  }
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    if (component === undefined || component.length === 0) {
      reject(`${field}.components[${index}]`, "must be nonempty");
    }
    if (component === "." || component === "..") {
      reject(`${field}.components[${index}]`, "must not equal . or ..");
    }
    const componentBytes = ENCODER.encode(component).byteLength;
    if (componentBytes > MAX_WORKSPACE_PATH_COMPONENT_UTF8_BYTES) {
      reject(
        `${field}.components[${index}]`,
        `must be at most ${MAX_WORKSPACE_PATH_COMPONENT_UTF8_BYTES} UTF-8 bytes`,
      );
    }
  }
  return frozen({ path: value, components: Object.freeze(components) });
}

export async function canonicalDirectoryPathDigest(value: unknown): Promise<A1Digest> {
  const path = parsePosixAbsoluteDirectory(value, "canonicalDirectoryPath").path;
  const writer = new CanonicalWriter();
  writer.str(CANONICAL_DIRECTORY_PATH_DIGEST_DOMAIN);
  writer.str(path);
  return parseA1Digest(base64urlEncode(await sha256(writer.finish())));
}

function parseRuntimeCoordinates(
  runtimeIdValue: unknown,
  incarnationValue: unknown,
  field: string,
): Readonly<{ runtimeId: NativeRuntimeId; nativeIncarnation: number }> {
  return frozen({
    runtimeId: parseA1CanonicalId("nativeRuntime", runtimeIdValue, `${field}.runtimeId`),
    nativeIncarnation: parsePositiveSafeInteger(incarnationValue, `${field}.nativeIncarnation`),
  });
}

export function parseLinuxMountNamespaceIdentity(value: unknown): LinuxMountNamespaceIdentityV1 {
  const row = parseExactRecord(value, MOUNT_NAMESPACE_KEYS, "linuxMountNamespaceIdentity");
  requireLiteral(
    row.schemaId,
    LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
    "linuxMountNamespaceIdentity.schemaId",
  );
  requireLiteral(row.schemaVersion, 1, "linuxMountNamespaceIdentity.schemaVersion");
  const coordinates = parseRuntimeCoordinates(
    row.runtimeId,
    row.nativeIncarnation,
    "linuxMountNamespaceIdentity",
  );
  requireLiteral(
    row.namespaceKind,
    LINUX_MOUNT_NAMESPACE_KIND,
    "linuxMountNamespaceIdentity.namespaceKind",
  );
  if (
    typeof row.bootId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.bootId)
  ) {
    reject("linuxMountNamespaceIdentity.bootId", "must be a lowercase UUID");
  }
  const namespaceFilesystemMagic = parseFilesystemMagic(
    row.namespaceFilesystemMagic,
    "linuxMountNamespaceIdentity.namespaceFilesystemMagic",
  );
  if (namespaceFilesystemMagic !== LINUX_NSFS_MAGIC_DECIMAL) {
    reject(
      "linuxMountNamespaceIdentity.namespaceFilesystemMagic",
      `must equal ${LINUX_NSFS_MAGIC_DECIMAL}`,
    );
  }
  return frozen({
    schemaId: LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
    schemaVersion: 1,
    ...coordinates,
    namespaceKind: LINUX_MOUNT_NAMESPACE_KIND,
    bootId: row.bootId,
    namespaceDevice: parseU64Decimal(
      row.namespaceDevice,
      "linuxMountNamespaceIdentity.namespaceDevice",
    ),
    namespaceInode: parsePositiveU64Decimal(
      row.namespaceInode,
      "linuxMountNamespaceIdentity.namespaceInode",
    ),
    namespaceFilesystemMagic: LINUX_NSFS_MAGIC_DECIMAL,
  });
}

export async function parsePosixCanonicalDirectoryEvidence(
  value: unknown,
): Promise<PosixCanonicalDirectoryEvidenceV1> {
  const row = parseExactRecord(value, CANONICAL_DIRECTORY_KEYS, "posixCanonicalDirectoryEvidence");
  requireLiteral(
    row.schemaId,
    POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID,
    "posixCanonicalDirectoryEvidence.schemaId",
  );
  requireLiteral(row.schemaVersion, 1, "posixCanonicalDirectoryEvidence.schemaVersion");
  const coordinates = parseRuntimeCoordinates(
    row.runtimeId,
    row.nativeIncarnation,
    "posixCanonicalDirectoryEvidence",
  );
  requireLiteral(
    row.directoryNormalizationSchemaId,
    NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
    "posixCanonicalDirectoryEvidence.directoryNormalizationSchemaId",
  );
  const canonicalDirectory = parsePosixAbsoluteDirectory(
    row.canonicalDirectory,
    "posixCanonicalDirectoryEvidence.canonicalDirectory",
  ).path;
  const canonicalDirectoryPathDigestValue = parseA1Digest(
    row.canonicalDirectoryPathDigest,
    "posixCanonicalDirectoryEvidence.canonicalDirectoryPathDigest",
  );
  const expectedPathDigest = await canonicalDirectoryPathDigest(canonicalDirectory);
  if (canonicalDirectoryPathDigestValue !== expectedPathDigest) {
    reject(
      "posixCanonicalDirectoryEvidence.canonicalDirectoryPathDigest",
      "does not match canonicalDirectory",
    );
  }
  return frozen({
    schemaId: POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID,
    schemaVersion: 1,
    ...coordinates,
    directoryNormalizationSchemaId: NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
    mountNamespaceArtifactDigest: parseA1Digest(
      row.mountNamespaceArtifactDigest,
      "posixCanonicalDirectoryEvidence.mountNamespaceArtifactDigest",
    ),
    canonicalDirectory,
    canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
  });
}

export function parseLinuxNoFollowFilesystemIdentity(
  value: unknown,
): LinuxNoFollowFilesystemIdentityV1 {
  const row = parseExactRecord(value, FILESYSTEM_IDENTITY_KEYS, "linuxNoFollowFilesystemIdentity");
  requireLiteral(
    row.schemaId,
    LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID,
    "linuxNoFollowFilesystemIdentity.schemaId",
  );
  requireLiteral(row.schemaVersion, 1, "linuxNoFollowFilesystemIdentity.schemaVersion");
  const coordinates = parseRuntimeCoordinates(
    row.runtimeId,
    row.nativeIncarnation,
    "linuxNoFollowFilesystemIdentity",
  );
  requireLiteral(
    row.fileKind,
    LINUX_DIRECTORY_FILE_KIND,
    "linuxNoFollowFilesystemIdentity.fileKind",
  );
  return frozen({
    schemaId: LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID,
    schemaVersion: 1,
    ...coordinates,
    mountNamespaceArtifactDigest: parseA1Digest(
      row.mountNamespaceArtifactDigest,
      "linuxNoFollowFilesystemIdentity.mountNamespaceArtifactDigest",
    ),
    canonicalDirectoryArtifactDigest: parseA1Digest(
      row.canonicalDirectoryArtifactDigest,
      "linuxNoFollowFilesystemIdentity.canonicalDirectoryArtifactDigest",
    ),
    canonicalDirectoryPathDigest: parseA1Digest(
      row.canonicalDirectoryPathDigest,
      "linuxNoFollowFilesystemIdentity.canonicalDirectoryPathDigest",
    ),
    fileKind: LINUX_DIRECTORY_FILE_KIND,
    directoryDevice: parseU64Decimal(
      row.directoryDevice,
      "linuxNoFollowFilesystemIdentity.directoryDevice",
    ),
    directoryInode: parsePositiveU64Decimal(
      row.directoryInode,
      "linuxNoFollowFilesystemIdentity.directoryInode",
    ),
    mountId: parsePositiveU64Decimal(row.mountId, "linuxNoFollowFilesystemIdentity.mountId"),
    filesystemMagic: parseFilesystemMagic(
      row.filesystemMagic,
      "linuxNoFollowFilesystemIdentity.filesystemMagic",
    ),
  });
}

function parseAncestryEntry(
  value: unknown,
  index: number,
  expectedComponent: string,
  field: string,
): LinuxAllowedRootAncestryEntryV1 {
  const row = parseExactRecord(value, ANCESTRY_ENTRY_KEYS, field);
  if (row.index !== index) reject(`${field}.index`, `must equal ${index}`);
  if (row.component !== expectedComponent) {
    reject(`${field}.component`, `must equal ${JSON.stringify(expectedComponent)}`);
  }
  return frozen({
    index,
    component: expectedComponent,
    directoryDevice: parseU64Decimal(row.directoryDevice, `${field}.directoryDevice`),
    directoryInode: parsePositiveU64Decimal(row.directoryInode, `${field}.directoryInode`),
    mountId: parsePositiveU64Decimal(row.mountId, `${field}.mountId`),
    filesystemMagic: parseFilesystemMagic(row.filesystemMagic, `${field}.filesystemMagic`),
  });
}

function parseAncestryVector(
  value: unknown,
  countValue: unknown,
  path: ParsedPosixAbsoluteDirectory,
  field: string,
): readonly LinuxAllowedRootAncestryEntryV1[] {
  const count = parsePositiveSafeInteger(countValue, `${field}Count`);
  const expectedCount = path.components.length + 1;
  if (count !== expectedCount) reject(`${field}Count`, `must equal ${expectedCount}`);
  if (count > MAX_WORKSPACE_ANCESTRY_ENTRIES) {
    reject(`${field}Count`, `must be at most ${MAX_WORKSPACE_ANCESTRY_ENTRIES}`);
  }
  const entries = snapshotExactArray(value, count, field);
  return Object.freeze(
    entries.map((entry, index) =>
      parseAncestryEntry(
        entry,
        index,
        index === 0 ? "/" : (path.components[index - 1] ?? ""),
        `${field}[${index}]`,
      ),
    ),
  );
}

function sameAncestryEntry(
  left: LinuxAllowedRootAncestryEntryV1,
  right: LinuxAllowedRootAncestryEntryV1,
): boolean {
  return (
    left.index === right.index &&
    left.component === right.component &&
    left.directoryDevice === right.directoryDevice &&
    left.directoryInode === right.directoryInode &&
    left.mountId === right.mountId &&
    left.filesystemMagic === right.filesystemMagic
  );
}

export async function parseLinuxAllowedRootAncestry(
  value: unknown,
): Promise<LinuxAllowedRootAncestryV1> {
  const row = parseExactRecord(value, ALLOWED_ROOT_KEYS, "linuxAllowedRootAncestry");
  requireLiteral(
    row.schemaId,
    LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID,
    "linuxAllowedRootAncestry.schemaId",
  );
  requireLiteral(row.schemaVersion, 1, "linuxAllowedRootAncestry.schemaVersion");
  const coordinates = parseRuntimeCoordinates(
    row.runtimeId,
    row.nativeIncarnation,
    "linuxAllowedRootAncestry",
  );
  requireLiteral(
    row.suffixMountPolicy,
    LINUX_ALLOWED_ROOT_SUFFIX_MOUNT_POLICY,
    "linuxAllowedRootAncestry.suffixMountPolicy",
  );
  const allowedRoot = parsePosixAbsoluteDirectory(
    row.allowedRoot,
    "linuxAllowedRootAncestry.allowedRoot",
  );
  // Parse the target path from its independently committed P artifact at bundle verification time.
  // Here the target vector itself provides its exact components; reconstruction below is compared to
  // the path digest, while containment is closed by the shared prefix with allowedRootEntries.
  const targetCount = parsePositiveSafeInteger(
    row.targetEntryCount,
    "linuxAllowedRootAncestry.targetEntriesCount",
  );
  if (targetCount > MAX_WORKSPACE_ANCESTRY_ENTRIES) {
    reject(
      "linuxAllowedRootAncestry.targetEntriesCount",
      `must be at most ${MAX_WORKSPACE_ANCESTRY_ENTRIES}`,
    );
  }
  const targetCandidates = snapshotExactArray(
    row.targetEntries,
    targetCount,
    "linuxAllowedRootAncestry.targetEntries",
  );
  const targetEntries = Object.freeze(
    targetCandidates.map((entry, index) => {
      const entryRow = parseExactRecord(
        entry,
        ANCESTRY_ENTRY_KEYS,
        `linuxAllowedRootAncestry.targetEntries[${index}]`,
      );
      if (entryRow.index !== index) {
        reject(`linuxAllowedRootAncestry.targetEntries[${index}].index`, `must equal ${index}`);
      }
      const component = entryRow.component;
      if (typeof component !== "string") {
        reject(`linuxAllowedRootAncestry.targetEntries[${index}].component`, "must be a string");
      }
      const expectedComponent = index === 0 ? "/" : component;
      if (index === 0 && component !== "/") {
        reject(`linuxAllowedRootAncestry.targetEntries[0].component`, 'must equal "/"');
      }
      if (index > 0) {
        assertUnicodeScalars(
          component,
          `linuxAllowedRootAncestry.targetEntries[${index}].component`,
        );
        const bytes = ENCODER.encode(component).byteLength;
        if (component.length === 0 || bytes > MAX_WORKSPACE_PATH_COMPONENT_UTF8_BYTES) {
          reject(
            `linuxAllowedRootAncestry.targetEntries[${index}].component`,
            `must contain 1..${MAX_WORKSPACE_PATH_COMPONENT_UTF8_BYTES} UTF-8 bytes`,
          );
        }
        if (component === "." || component === ".." || component.includes("/")) {
          reject(
            `linuxAllowedRootAncestry.targetEntries[${index}].component`,
            "must be one exact POSIX path component",
          );
        }
      }
      return parseAncestryEntry(
        entryRow,
        index,
        expectedComponent,
        `linuxAllowedRootAncestry.targetEntries[${index}]`,
      );
    }),
  );
  const targetPathValue =
    targetEntries.length === 1
      ? "/"
      : `/${targetEntries
          .slice(1)
          .map((entry) => entry.component)
          .join("/")}`;
  const parsedTarget = parsePosixAbsoluteDirectory(
    targetPathValue,
    "linuxAllowedRootAncestry.targetPath",
  );
  const allowedRootEntries = parseAncestryVector(
    row.allowedRootEntries,
    row.allowedRootEntryCount,
    allowedRoot,
    "linuxAllowedRootAncestry.allowedRootEntries",
  );
  if (allowedRoot.components.length > parsedTarget.components.length) {
    reject("linuxAllowedRootAncestry.allowedRoot", "must contain canonicalDirectory");
  }
  for (let index = 0; index < allowedRoot.components.length; index++) {
    if (allowedRoot.components[index] !== parsedTarget.components[index]) {
      reject(
        "linuxAllowedRootAncestry.allowedRoot",
        "must be a component prefix of canonicalDirectory",
      );
    }
  }
  for (let index = 0; index < allowedRootEntries.length; index++) {
    const allowedRootEntry = allowedRootEntries[index];
    const targetEntry = targetEntries[index];
    if (
      allowedRootEntry === undefined ||
      targetEntry === undefined ||
      !sameAncestryEntry(allowedRootEntry, targetEntry)
    ) {
      reject(
        `linuxAllowedRootAncestry.targetEntries[${index}]`,
        "must equal the overlapping allowed-root entry",
      );
    }
  }
  const allowedRootFinal = allowedRootEntries.at(-1);
  if (allowedRootFinal === undefined)
    reject("linuxAllowedRootAncestry.allowedRootEntries", "is empty");
  for (let index = allowedRootEntries.length; index < targetEntries.length; index++) {
    if (targetEntries[index]?.mountId !== allowedRootFinal.mountId) {
      reject(
        `linuxAllowedRootAncestry.targetEntries[${index}].mountId`,
        "must equal the allowed root mountId",
      );
    }
  }
  const allowedRootPathDigestValue = parseA1Digest(
    row.allowedRootPathDigest,
    "linuxAllowedRootAncestry.allowedRootPathDigest",
  );
  const canonicalDirectoryPathDigestValue = parseA1Digest(
    row.canonicalDirectoryPathDigest,
    "linuxAllowedRootAncestry.canonicalDirectoryPathDigest",
  );
  const [expectedAllowedRootDigest, expectedTargetDigest] = await Promise.all([
    canonicalDirectoryPathDigest(allowedRoot.path),
    canonicalDirectoryPathDigest(parsedTarget.path),
  ]);
  if (allowedRootPathDigestValue !== expectedAllowedRootDigest) {
    reject("linuxAllowedRootAncestry.allowedRootPathDigest", "does not match allowedRoot");
  }
  if (canonicalDirectoryPathDigestValue !== expectedTargetDigest) {
    reject("linuxAllowedRootAncestry.canonicalDirectoryPathDigest", "does not match targetEntries");
  }
  return frozen({
    schemaId: LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID,
    schemaVersion: 1,
    ...coordinates,
    mountNamespaceArtifactDigest: parseA1Digest(
      row.mountNamespaceArtifactDigest,
      "linuxAllowedRootAncestry.mountNamespaceArtifactDigest",
    ),
    canonicalDirectoryArtifactDigest: parseA1Digest(
      row.canonicalDirectoryArtifactDigest,
      "linuxAllowedRootAncestry.canonicalDirectoryArtifactDigest",
    ),
    filesystemIdentityArtifactDigest: parseA1Digest(
      row.filesystemIdentityArtifactDigest,
      "linuxAllowedRootAncestry.filesystemIdentityArtifactDigest",
    ),
    suffixMountPolicy: LINUX_ALLOWED_ROOT_SUFFIX_MOUNT_POLICY,
    allowedRoot: allowedRoot.path,
    allowedRootPathDigest: allowedRootPathDigestValue,
    canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
    allowedRootEntryCount: allowedRootEntries.length,
    allowedRootEntries,
    targetEntryCount: targetEntries.length,
    targetEntries,
  });
}

function writeU64(writer: CanonicalWriter, value: U64Decimal): void {
  writer.bytes(u64be(value));
}

function ensureEncodedBound(bytes: Uint8Array, maxBytes: number, field: string): Uint8Array {
  return boundedByteSnapshot(bytes, maxBytes, field);
}

function encodeParsedMountNamespace(value: LinuxMountNamespaceIdentityV1): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(value.schemaId);
  writer.uint(value.schemaVersion);
  writer.str(value.runtimeId);
  writer.uint(value.nativeIncarnation);
  writer.str(value.namespaceKind);
  writer.str(value.bootId);
  writeU64(writer, value.namespaceDevice);
  writeU64(writer, value.namespaceInode);
  writeU64(writer, value.namespaceFilesystemMagic);
  return ensureEncodedBound(
    writer.finish(),
    MAX_LINUX_MOUNT_NAMESPACE_IDENTITY_BYTES,
    "linuxMountNamespaceIdentityBytes",
  );
}

export function encodeLinuxMountNamespaceIdentity(value: unknown): Uint8Array {
  return encodeParsedMountNamespace(parseLinuxMountNamespaceIdentity(value));
}

function encodeParsedCanonicalDirectory(value: PosixCanonicalDirectoryEvidenceV1): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(value.schemaId);
  writer.uint(value.schemaVersion);
  writer.str(value.runtimeId);
  writer.uint(value.nativeIncarnation);
  writer.str(value.directoryNormalizationSchemaId);
  writer.bytes(base64urlDecode(value.mountNamespaceArtifactDigest));
  writer.str(value.canonicalDirectory);
  writer.bytes(base64urlDecode(value.canonicalDirectoryPathDigest));
  return ensureEncodedBound(
    writer.finish(),
    MAX_POSIX_CANONICAL_DIRECTORY_EVIDENCE_BYTES,
    "posixCanonicalDirectoryEvidenceBytes",
  );
}

export async function encodePosixCanonicalDirectoryEvidence(value: unknown): Promise<Uint8Array> {
  return encodeParsedCanonicalDirectory(await parsePosixCanonicalDirectoryEvidence(value));
}

function encodeParsedFilesystemIdentity(value: LinuxNoFollowFilesystemIdentityV1): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(value.schemaId);
  writer.uint(value.schemaVersion);
  writer.str(value.runtimeId);
  writer.uint(value.nativeIncarnation);
  writer.bytes(base64urlDecode(value.mountNamespaceArtifactDigest));
  writer.bytes(base64urlDecode(value.canonicalDirectoryArtifactDigest));
  writer.bytes(base64urlDecode(value.canonicalDirectoryPathDigest));
  writer.str(value.fileKind);
  writeU64(writer, value.directoryDevice);
  writeU64(writer, value.directoryInode);
  writeU64(writer, value.mountId);
  writeU64(writer, value.filesystemMagic);
  return ensureEncodedBound(
    writer.finish(),
    MAX_LINUX_FILESYSTEM_IDENTITY_EVIDENCE_BYTES,
    "linuxNoFollowFilesystemIdentityBytes",
  );
}

export function encodeLinuxNoFollowFilesystemIdentity(value: unknown): Uint8Array {
  return encodeParsedFilesystemIdentity(parseLinuxNoFollowFilesystemIdentity(value));
}

function writeAncestryEntry(writer: CanonicalWriter, entry: LinuxAllowedRootAncestryEntryV1): void {
  writer.uint(entry.index);
  writer.str(entry.component);
  writeU64(writer, entry.directoryDevice);
  writeU64(writer, entry.directoryInode);
  writeU64(writer, entry.mountId);
  writeU64(writer, entry.filesystemMagic);
}

function encodeParsedAllowedRoot(value: LinuxAllowedRootAncestryV1): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(value.schemaId);
  writer.uint(value.schemaVersion);
  writer.str(value.runtimeId);
  writer.uint(value.nativeIncarnation);
  writer.bytes(base64urlDecode(value.mountNamespaceArtifactDigest));
  writer.bytes(base64urlDecode(value.canonicalDirectoryArtifactDigest));
  writer.bytes(base64urlDecode(value.filesystemIdentityArtifactDigest));
  writer.str(value.suffixMountPolicy);
  writer.str(value.allowedRoot);
  writer.bytes(base64urlDecode(value.allowedRootPathDigest));
  writer.bytes(base64urlDecode(value.canonicalDirectoryPathDigest));
  writer.uint(value.allowedRootEntryCount);
  for (const entry of value.allowedRootEntries) writeAncestryEntry(writer, entry);
  writer.uint(value.targetEntryCount);
  for (const entry of value.targetEntries) writeAncestryEntry(writer, entry);
  return ensureEncodedBound(
    writer.finish(),
    MAX_LINUX_ALLOWED_ROOT_ANCESTRY_BYTES,
    "linuxAllowedRootAncestryBytes",
  );
}

export async function encodeLinuxAllowedRootAncestry(value: unknown): Promise<Uint8Array> {
  return encodeParsedAllowedRoot(await parseLinuxAllowedRootAncestry(value));
}

class WorkspaceEvidenceReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;
  #offset = 0;

  constructor(value: Uint8Array, maxBytes: number, field: string) {
    this.#bytes = boundedByteSnapshot(value, maxBytes, field) as Uint8Array<ArrayBuffer>;
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

  u64(field: string): U64Decimal {
    const bytes = this.bytes(field, 8);
    return parseU64Decimal(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .getBigUint64(0, false)
        .toString(),
      field,
    );
  }

  snapshot(): Uint8Array<ArrayBuffer> {
    return this.#bytes.slice();
  }

  finish(field: string): void {
    if (this.#offset !== this.#bytes.byteLength) reject(field, "must not contain trailing bytes");
  }
}

function requireExactEncoding(encoded: Uint8Array, source: Uint8Array, field: string): void {
  if (!timingSafeEqual(encoded, source)) reject(field, "must use the exact canonical encoding");
}

export function decodeLinuxMountNamespaceIdentity(
  value: Uint8Array,
): LinuxMountNamespaceIdentityV1 {
  const reader = new WorkspaceEvidenceReader(
    value,
    MAX_LINUX_MOUNT_NAMESPACE_IDENTITY_BYTES,
    "linuxMountNamespaceIdentityBytes",
  );
  const source = reader.snapshot();
  const result = parseLinuxMountNamespaceIdentity({
    schemaId: reader.str("linuxMountNamespaceIdentity.schemaId"),
    schemaVersion: reader.uint("linuxMountNamespaceIdentity.schemaVersion"),
    runtimeId: reader.str("linuxMountNamespaceIdentity.runtimeId"),
    nativeIncarnation: reader.uint("linuxMountNamespaceIdentity.nativeIncarnation"),
    namespaceKind: reader.str("linuxMountNamespaceIdentity.namespaceKind"),
    bootId: reader.str("linuxMountNamespaceIdentity.bootId"),
    namespaceDevice: reader.u64("linuxMountNamespaceIdentity.namespaceDevice"),
    namespaceInode: reader.u64("linuxMountNamespaceIdentity.namespaceInode"),
    namespaceFilesystemMagic: reader.u64("linuxMountNamespaceIdentity.namespaceFilesystemMagic"),
  });
  reader.finish("linuxMountNamespaceIdentityBytes");
  requireExactEncoding(
    encodeParsedMountNamespace(result),
    source,
    "linuxMountNamespaceIdentityBytes",
  );
  return result;
}

export async function decodePosixCanonicalDirectoryEvidence(
  value: Uint8Array,
): Promise<PosixCanonicalDirectoryEvidenceV1> {
  const reader = new WorkspaceEvidenceReader(
    value,
    MAX_POSIX_CANONICAL_DIRECTORY_EVIDENCE_BYTES,
    "posixCanonicalDirectoryEvidenceBytes",
  );
  const source = reader.snapshot();
  const decoded = {
    schemaId: reader.str("posixCanonicalDirectoryEvidence.schemaId"),
    schemaVersion: reader.uint("posixCanonicalDirectoryEvidence.schemaVersion"),
    runtimeId: reader.str("posixCanonicalDirectoryEvidence.runtimeId"),
    nativeIncarnation: reader.uint("posixCanonicalDirectoryEvidence.nativeIncarnation"),
    directoryNormalizationSchemaId: reader.str(
      "posixCanonicalDirectoryEvidence.directoryNormalizationSchemaId",
    ),
    mountNamespaceArtifactDigest: base64urlEncode(
      reader.bytes("posixCanonicalDirectoryEvidence.mountNamespaceArtifactDigest", 32),
    ),
    canonicalDirectory: reader.str("posixCanonicalDirectoryEvidence.canonicalDirectory"),
    canonicalDirectoryPathDigest: base64urlEncode(
      reader.bytes("posixCanonicalDirectoryEvidence.canonicalDirectoryPathDigest", 32),
    ),
  };
  reader.finish("posixCanonicalDirectoryEvidenceBytes");
  const result = await parsePosixCanonicalDirectoryEvidence(decoded);
  requireExactEncoding(
    encodeParsedCanonicalDirectory(result),
    source,
    "posixCanonicalDirectoryEvidenceBytes",
  );
  return result;
}

export function decodeLinuxNoFollowFilesystemIdentity(
  value: Uint8Array,
): LinuxNoFollowFilesystemIdentityV1 {
  const reader = new WorkspaceEvidenceReader(
    value,
    MAX_LINUX_FILESYSTEM_IDENTITY_EVIDENCE_BYTES,
    "linuxNoFollowFilesystemIdentityBytes",
  );
  const source = reader.snapshot();
  const result = parseLinuxNoFollowFilesystemIdentity({
    schemaId: reader.str("linuxNoFollowFilesystemIdentity.schemaId"),
    schemaVersion: reader.uint("linuxNoFollowFilesystemIdentity.schemaVersion"),
    runtimeId: reader.str("linuxNoFollowFilesystemIdentity.runtimeId"),
    nativeIncarnation: reader.uint("linuxNoFollowFilesystemIdentity.nativeIncarnation"),
    mountNamespaceArtifactDigest: base64urlEncode(
      reader.bytes("linuxNoFollowFilesystemIdentity.mountNamespaceArtifactDigest", 32),
    ),
    canonicalDirectoryArtifactDigest: base64urlEncode(
      reader.bytes("linuxNoFollowFilesystemIdentity.canonicalDirectoryArtifactDigest", 32),
    ),
    canonicalDirectoryPathDigest: base64urlEncode(
      reader.bytes("linuxNoFollowFilesystemIdentity.canonicalDirectoryPathDigest", 32),
    ),
    fileKind: reader.str("linuxNoFollowFilesystemIdentity.fileKind"),
    directoryDevice: reader.u64("linuxNoFollowFilesystemIdentity.directoryDevice"),
    directoryInode: reader.u64("linuxNoFollowFilesystemIdentity.directoryInode"),
    mountId: reader.u64("linuxNoFollowFilesystemIdentity.mountId"),
    filesystemMagic: reader.u64("linuxNoFollowFilesystemIdentity.filesystemMagic"),
  });
  reader.finish("linuxNoFollowFilesystemIdentityBytes");
  requireExactEncoding(
    encodeParsedFilesystemIdentity(result),
    source,
    "linuxNoFollowFilesystemIdentityBytes",
  );
  return result;
}

function readAncestryEntries(
  reader: WorkspaceEvidenceReader,
  count: number,
  field: string,
): readonly Record<string, unknown>[] {
  if (count > MAX_WORKSPACE_ANCESTRY_ENTRIES) {
    reject(`${field}Count`, `must be at most ${MAX_WORKSPACE_ANCESTRY_ENTRIES}`);
  }
  const entries: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index++) {
    entries.push({
      index: reader.uint(`${field}[${index}].index`),
      component: reader.str(`${field}[${index}].component`),
      directoryDevice: reader.u64(`${field}[${index}].directoryDevice`),
      directoryInode: reader.u64(`${field}[${index}].directoryInode`),
      mountId: reader.u64(`${field}[${index}].mountId`),
      filesystemMagic: reader.u64(`${field}[${index}].filesystemMagic`),
    });
  }
  return Object.freeze(entries);
}

export async function decodeLinuxAllowedRootAncestry(
  value: Uint8Array,
): Promise<LinuxAllowedRootAncestryV1> {
  const reader = new WorkspaceEvidenceReader(
    value,
    MAX_LINUX_ALLOWED_ROOT_ANCESTRY_BYTES,
    "linuxAllowedRootAncestryBytes",
  );
  const source = reader.snapshot();
  const schemaId = reader.str("linuxAllowedRootAncestry.schemaId");
  const schemaVersion = reader.uint("linuxAllowedRootAncestry.schemaVersion");
  const runtimeId = reader.str("linuxAllowedRootAncestry.runtimeId");
  const nativeIncarnation = reader.uint("linuxAllowedRootAncestry.nativeIncarnation");
  const mountNamespaceArtifactDigest = base64urlEncode(
    reader.bytes("linuxAllowedRootAncestry.mountNamespaceArtifactDigest", 32),
  );
  const canonicalDirectoryArtifactDigest = base64urlEncode(
    reader.bytes("linuxAllowedRootAncestry.canonicalDirectoryArtifactDigest", 32),
  );
  const filesystemIdentityArtifactDigest = base64urlEncode(
    reader.bytes("linuxAllowedRootAncestry.filesystemIdentityArtifactDigest", 32),
  );
  const suffixMountPolicy = reader.str("linuxAllowedRootAncestry.suffixMountPolicy");
  const allowedRoot = reader.str("linuxAllowedRootAncestry.allowedRoot");
  const allowedRootPathDigest = base64urlEncode(
    reader.bytes("linuxAllowedRootAncestry.allowedRootPathDigest", 32),
  );
  const canonicalDirectoryPathDigestValue = base64urlEncode(
    reader.bytes("linuxAllowedRootAncestry.canonicalDirectoryPathDigest", 32),
  );
  const allowedRootEntryCount = reader.uint("linuxAllowedRootAncestry.allowedRootEntryCount");
  const allowedRootEntries = readAncestryEntries(
    reader,
    allowedRootEntryCount,
    "linuxAllowedRootAncestry.allowedRootEntries",
  );
  const targetEntryCount = reader.uint("linuxAllowedRootAncestry.targetEntryCount");
  const targetEntries = readAncestryEntries(
    reader,
    targetEntryCount,
    "linuxAllowedRootAncestry.targetEntries",
  );
  reader.finish("linuxAllowedRootAncestryBytes");
  const result = await parseLinuxAllowedRootAncestry({
    schemaId,
    schemaVersion,
    runtimeId,
    nativeIncarnation,
    mountNamespaceArtifactDigest,
    canonicalDirectoryArtifactDigest,
    filesystemIdentityArtifactDigest,
    suffixMountPolicy,
    allowedRoot,
    allowedRootPathDigest,
    canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
    allowedRootEntryCount,
    allowedRootEntries,
    targetEntryCount,
    targetEntries,
  });
  requireExactEncoding(encodeParsedAllowedRoot(result), source, "linuxAllowedRootAncestryBytes");
  return result;
}

async function canonicalArtifact<Role extends WorkspaceEvidenceRole, Evidence>(
  canonicalBytes: Uint8Array,
  evidence: Evidence,
  role: Role,
): Promise<CanonicalWorkspaceEvidenceArtifact<Role, Evidence>> {
  const commitment = parseNativeEvidenceArtifactCommitment(
    {
      role,
      artifactSchemaId: NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS[role].artifactSchemaId,
      artifactDigest: await nativeBindingAuthorityArtifactDigest(canonicalBytes),
      byteLength: canonicalBytes.byteLength,
    },
    role,
  );
  return frozen({
    canonicalBytes: ProtectedByteSnapshot.from(canonicalBytes),
    evidence,
    commitment,
  });
}

export async function canonicalLinuxMountNamespaceIdentityArtifact(
  value: unknown,
): Promise<
  CanonicalWorkspaceEvidenceArtifact<"workspace.mount_namespace", LinuxMountNamespaceIdentityV1>
> {
  const canonicalBytes = encodeLinuxMountNamespaceIdentity(value);
  const evidence = decodeLinuxMountNamespaceIdentity(canonicalBytes);
  return canonicalArtifact(canonicalBytes, evidence, "workspace.mount_namespace");
}

export async function canonicalPosixCanonicalDirectoryEvidenceArtifact(
  value: unknown,
): Promise<
  CanonicalWorkspaceEvidenceArtifact<
    "workspace.canonical_directory",
    PosixCanonicalDirectoryEvidenceV1
  >
> {
  const canonicalBytes = await encodePosixCanonicalDirectoryEvidence(value);
  const evidence = await decodePosixCanonicalDirectoryEvidence(canonicalBytes);
  return canonicalArtifact(canonicalBytes, evidence, "workspace.canonical_directory");
}

export async function canonicalLinuxNoFollowFilesystemIdentityArtifact(
  value: unknown,
): Promise<
  CanonicalWorkspaceEvidenceArtifact<
    "workspace.filesystem_identity",
    LinuxNoFollowFilesystemIdentityV1
  >
> {
  const canonicalBytes = encodeLinuxNoFollowFilesystemIdentity(value);
  const evidence = decodeLinuxNoFollowFilesystemIdentity(canonicalBytes);
  return canonicalArtifact(canonicalBytes, evidence, "workspace.filesystem_identity");
}

export async function canonicalLinuxAllowedRootAncestryArtifact(
  value: unknown,
): Promise<
  CanonicalWorkspaceEvidenceArtifact<"workspace.allowed_root", LinuxAllowedRootAncestryV1>
> {
  const canonicalBytes = await encodeLinuxAllowedRootAncestry(value);
  const evidence = await decodeLinuxAllowedRootAncestry(canonicalBytes);
  return canonicalArtifact(canonicalBytes, evidence, "workspace.allowed_root");
}

function snapshotBoundedBytes(value: unknown, maxBytes: number, field: string): Uint8Array {
  return boundedByteSnapshot(value, maxBytes, field);
}

function requireEqual(value: unknown, expected: unknown, field: string): void {
  if (value !== expected) reject(field, "does not match the workspace evidence bundle");
}

function verifyParentCommitment<Role extends WorkspaceEvidenceRole>(
  actual: NativeEvidenceArtifactCommitmentV1,
  role: Role,
  digest: A1Digest,
  byteLength: number,
  field: string,
): NativeEvidenceArtifactCommitmentV1<Role> {
  const expected = parseNativeEvidenceArtifactCommitment(
    {
      role,
      artifactSchemaId: NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS[role].artifactSchemaId,
      artifactDigest: digest,
      byteLength,
    },
    role,
  );
  requireEqual(actual.role, expected.role, `${field}.role`);
  requireEqual(actual.artifactSchemaId, expected.artifactSchemaId, `${field}.artifactSchemaId`);
  requireEqual(actual.artifactDigest, expected.artifactDigest, `${field}.artifactDigest`);
  requireEqual(actual.byteLength, expected.byteLength, `${field}.byteLength`);
  return expected;
}

export async function verifyCanonicalWorkspaceEvidenceBundle(
  input: CanonicalWorkspaceEvidenceBundleInput,
): Promise<CanonicalWorkspaceEvidenceBundle> {
  const row = parseExactRecord(input, BUNDLE_INPUT_KEYS, "canonicalWorkspaceEvidenceBundle");
  // All five caller-controlled views are bounded and copied before the first await.
  const mountNamespaceBytes = snapshotBoundedBytes(
    row.mountNamespaceBytes,
    MAX_LINUX_MOUNT_NAMESPACE_IDENTITY_BYTES,
    "canonicalWorkspaceEvidenceBundle.mountNamespaceBytes",
  );
  const canonicalDirectoryBytes = snapshotBoundedBytes(
    row.canonicalDirectoryBytes,
    MAX_POSIX_CANONICAL_DIRECTORY_EVIDENCE_BYTES,
    "canonicalWorkspaceEvidenceBundle.canonicalDirectoryBytes",
  );
  const filesystemIdentityBytes = snapshotBoundedBytes(
    row.filesystemIdentityBytes,
    MAX_LINUX_FILESYSTEM_IDENTITY_EVIDENCE_BYTES,
    "canonicalWorkspaceEvidenceBundle.filesystemIdentityBytes",
  );
  const allowedRootBytes = snapshotBoundedBytes(
    row.allowedRootBytes,
    MAX_LINUX_ALLOWED_ROOT_ANCESTRY_BYTES,
    "canonicalWorkspaceEvidenceBundle.allowedRootBytes",
  );
  const workspaceParentBytes = snapshotBoundedBytes(
    row.workspaceParentBytes,
    MAX_NATIVE_EVIDENCE_PARENT_BYTES,
    "canonicalWorkspaceEvidenceBundle.workspaceParentBytes",
  );

  const mountNamespaceEvidence = decodeLinuxMountNamespaceIdentity(mountNamespaceBytes);
  const filesystemIdentityEvidence = decodeLinuxNoFollowFilesystemIdentity(filesystemIdentityBytes);
  const workspaceParentInput = decodeNativeWorkspaceBindingInput(workspaceParentBytes);
  requireExactEncoding(
    encodeNativeWorkspaceBindingInput(workspaceParentInput),
    workspaceParentBytes,
    "canonicalWorkspaceEvidenceBundle.workspaceParentBytes",
  );
  const [canonicalDirectoryEvidence, allowedRootEvidence] = await Promise.all([
    decodePosixCanonicalDirectoryEvidence(canonicalDirectoryBytes),
    decodeLinuxAllowedRootAncestry(allowedRootBytes),
  ]);
  const [
    mountNamespaceArtifactDigest,
    canonicalDirectoryArtifactDigest,
    filesystemIdentityArtifactDigest,
    allowedRootArtifactDigest,
    workspaceInputDigest,
  ] = await Promise.all([
    nativeBindingAuthorityArtifactDigest(mountNamespaceBytes),
    nativeBindingAuthorityArtifactDigest(canonicalDirectoryBytes),
    nativeBindingAuthorityArtifactDigest(filesystemIdentityBytes),
    nativeBindingAuthorityArtifactDigest(allowedRootBytes),
    nativeBindingAuthorityArtifactDigest(workspaceParentBytes),
  ]);

  requireEqual(
    canonicalDirectoryEvidence.mountNamespaceArtifactDigest,
    mountNamespaceArtifactDigest,
    "canonicalWorkspaceEvidenceBundle.canonicalDirectory.mountNamespaceArtifactDigest",
  );
  requireEqual(
    filesystemIdentityEvidence.mountNamespaceArtifactDigest,
    mountNamespaceArtifactDigest,
    "canonicalWorkspaceEvidenceBundle.filesystemIdentity.mountNamespaceArtifactDigest",
  );
  requireEqual(
    filesystemIdentityEvidence.canonicalDirectoryArtifactDigest,
    canonicalDirectoryArtifactDigest,
    "canonicalWorkspaceEvidenceBundle.filesystemIdentity.canonicalDirectoryArtifactDigest",
  );
  requireEqual(
    filesystemIdentityEvidence.canonicalDirectoryPathDigest,
    canonicalDirectoryEvidence.canonicalDirectoryPathDigest,
    "canonicalWorkspaceEvidenceBundle.filesystemIdentity.canonicalDirectoryPathDigest",
  );
  requireEqual(
    allowedRootEvidence.mountNamespaceArtifactDigest,
    mountNamespaceArtifactDigest,
    "canonicalWorkspaceEvidenceBundle.allowedRoot.mountNamespaceArtifactDigest",
  );
  requireEqual(
    allowedRootEvidence.canonicalDirectoryArtifactDigest,
    canonicalDirectoryArtifactDigest,
    "canonicalWorkspaceEvidenceBundle.allowedRoot.canonicalDirectoryArtifactDigest",
  );
  requireEqual(
    allowedRootEvidence.filesystemIdentityArtifactDigest,
    filesystemIdentityArtifactDigest,
    "canonicalWorkspaceEvidenceBundle.allowedRoot.filesystemIdentityArtifactDigest",
  );
  requireEqual(
    allowedRootEvidence.canonicalDirectoryPathDigest,
    canonicalDirectoryEvidence.canonicalDirectoryPathDigest,
    "canonicalWorkspaceEvidenceBundle.allowedRoot.canonicalDirectoryPathDigest",
  );

  const leaves = [
    mountNamespaceEvidence,
    canonicalDirectoryEvidence,
    filesystemIdentityEvidence,
    allowedRootEvidence,
  ] as const;
  for (let index = 0; index < leaves.length; index++) {
    const leaf = leaves[index];
    if (leaf === undefined) reject("canonicalWorkspaceEvidenceBundle.leaves", "is incomplete");
    requireEqual(
      leaf.runtimeId,
      workspaceParentInput.runtimeId,
      `canonicalWorkspaceEvidenceBundle.leaves[${index}].runtimeId`,
    );
    requireEqual(
      leaf.nativeIncarnation,
      workspaceParentInput.nativeIncarnation,
      `canonicalWorkspaceEvidenceBundle.leaves[${index}].nativeIncarnation`,
    );
  }
  requireEqual(
    workspaceParentInput.directoryNormalizationSchemaId,
    canonicalDirectoryEvidence.directoryNormalizationSchemaId,
    "canonicalWorkspaceEvidenceBundle.workspaceParent.directoryNormalizationSchemaId",
  );
  requireEqual(
    workspaceParentInput.filesystemIdentitySchemaId,
    filesystemIdentityEvidence.schemaId,
    "canonicalWorkspaceEvidenceBundle.workspaceParent.filesystemIdentitySchemaId",
  );

  const finalTargetEntry = allowedRootEvidence.targetEntries.at(-1);
  if (finalTargetEntry === undefined) {
    reject("canonicalWorkspaceEvidenceBundle.allowedRoot.targetEntries", "must be nonempty");
  }
  requireEqual(
    finalTargetEntry.directoryDevice,
    filesystemIdentityEvidence.directoryDevice,
    "canonicalWorkspaceEvidenceBundle.allowedRoot.targetEntries.final.directoryDevice",
  );
  requireEqual(
    finalTargetEntry.directoryInode,
    filesystemIdentityEvidence.directoryInode,
    "canonicalWorkspaceEvidenceBundle.allowedRoot.targetEntries.final.directoryInode",
  );
  requireEqual(
    finalTargetEntry.mountId,
    filesystemIdentityEvidence.mountId,
    "canonicalWorkspaceEvidenceBundle.allowedRoot.targetEntries.final.mountId",
  );
  requireEqual(
    finalTargetEntry.filesystemMagic,
    filesystemIdentityEvidence.filesystemMagic,
    "canonicalWorkspaceEvidenceBundle.allowedRoot.targetEntries.final.filesystemMagic",
  );

  const canonicalDirectoryCommitment = verifyParentCommitment(
    workspaceParentInput.artifacts[0],
    "workspace.canonical_directory",
    canonicalDirectoryArtifactDigest,
    canonicalDirectoryBytes.byteLength,
    "canonicalWorkspaceEvidenceBundle.workspaceParent.artifacts[0]",
  );
  const filesystemIdentityCommitment = verifyParentCommitment(
    workspaceParentInput.artifacts[1],
    "workspace.filesystem_identity",
    filesystemIdentityArtifactDigest,
    filesystemIdentityBytes.byteLength,
    "canonicalWorkspaceEvidenceBundle.workspaceParent.artifacts[1]",
  );
  const allowedRootCommitment = verifyParentCommitment(
    workspaceParentInput.artifacts[2],
    "workspace.allowed_root",
    allowedRootArtifactDigest,
    allowedRootBytes.byteLength,
    "canonicalWorkspaceEvidenceBundle.workspaceParent.artifacts[2]",
  );
  const mountNamespaceCommitment = verifyParentCommitment(
    workspaceParentInput.artifacts[3],
    "workspace.mount_namespace",
    mountNamespaceArtifactDigest,
    mountNamespaceBytes.byteLength,
    "canonicalWorkspaceEvidenceBundle.workspaceParent.artifacts[3]",
  );
  const workspaceParentCommitment = parseNativeEvidenceArtifactCommitment(
    {
      role: "parent.workspace_input",
      artifactSchemaId:
        NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["parent.workspace_input"].artifactSchemaId,
      artifactDigest: workspaceInputDigest,
      byteLength: workspaceParentBytes.byteLength,
    },
    "parent.workspace_input",
  );
  const workspaceSlot: NativeWorkspaceSlot =
    workspaceParentInput.nativeWorkspaceId === null
      ? frozen({
          kind: "canonical_directory_path_digest",
          value: canonicalDirectoryEvidence.canonicalDirectoryPathDigest,
        })
      : frozen({ kind: "native_workspace_id", value: workspaceParentInput.nativeWorkspaceId });

  return frozen({
    mountNamespace: frozen({
      canonicalBytes: ProtectedByteSnapshot.from(mountNamespaceBytes),
      evidence: mountNamespaceEvidence,
      commitment: mountNamespaceCommitment,
    }),
    canonicalDirectory: frozen({
      canonicalBytes: ProtectedByteSnapshot.from(canonicalDirectoryBytes),
      evidence: canonicalDirectoryEvidence,
      commitment: canonicalDirectoryCommitment,
    }),
    filesystemIdentity: frozen({
      canonicalBytes: ProtectedByteSnapshot.from(filesystemIdentityBytes),
      evidence: filesystemIdentityEvidence,
      commitment: filesystemIdentityCommitment,
    }),
    allowedRoot: frozen({
      canonicalBytes: ProtectedByteSnapshot.from(allowedRootBytes),
      evidence: allowedRootEvidence,
      commitment: allowedRootCommitment,
    }),
    workspaceParent: frozen({
      canonicalBytes: ProtectedByteSnapshot.from(workspaceParentBytes),
      input: workspaceParentInput,
      commitment: workspaceParentCommitment,
    }),
    workspaceSlot,
    workspaceInputDigest,
  });
}

// Compile-time closure against E1a's settled registry and bounds.
const _mountSchemaClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["workspace.mount_namespace"]["artifactSchemaId"] =
  LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID;
const _isolationMountSchemaClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["isolation.mount_namespace"]["artifactSchemaId"] =
  LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID;
const _canonicalDirectorySchemaClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["workspace.canonical_directory"]["artifactSchemaId"] =
  POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID;
const _filesystemSchemaClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["workspace.filesystem_identity"]["artifactSchemaId"] =
  LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID;
const _allowedRootSchemaClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["workspace.allowed_root"]["artifactSchemaId"] =
  LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID;
const _mountBoundClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["workspace.mount_namespace"]["maxByteLength"] =
  MAX_LINUX_MOUNT_NAMESPACE_IDENTITY_BYTES;
const _isolationMountBoundClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["isolation.mount_namespace"]["maxByteLength"] =
  MAX_LINUX_MOUNT_NAMESPACE_IDENTITY_BYTES;
const _canonicalDirectoryBoundClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["workspace.canonical_directory"]["maxByteLength"] =
  MAX_POSIX_CANONICAL_DIRECTORY_EVIDENCE_BYTES;
const _filesystemBoundClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["workspace.filesystem_identity"]["maxByteLength"] =
  MAX_LINUX_FILESYSTEM_IDENTITY_EVIDENCE_BYTES;
const _allowedRootBoundClosure: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)["workspace.allowed_root"]["maxByteLength"] =
  MAX_LINUX_ALLOWED_ROOT_ANCESTRY_BYTES;
void _mountSchemaClosure;
void _isolationMountSchemaClosure;
void _canonicalDirectorySchemaClosure;
void _filesystemSchemaClosure;
void _allowedRootSchemaClosure;
void _mountBoundClosure;
void _isolationMountBoundClosure;
void _canonicalDirectoryBoundClosure;
void _filesystemBoundClosure;
void _allowedRootBoundClosure;
