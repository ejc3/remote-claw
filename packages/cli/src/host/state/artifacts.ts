import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { base64urlDecode, base64urlEncode, timingSafeEqual } from "@remote-claw/clawsec";
import { type A1Digest, HostStateContractError, parseA1CanonicalId, parseA1Digest } from "./ids.js";
import {
  type ProtectedArtifactOperations,
  ProtectedByteSnapshot,
  type ProtectedHandleRef,
  type ProtectedOperationScope,
  type PutArtifactRequest,
  type PutArtifactResult,
  parseProtectedHandleRef,
  parseProtectedOperationScope,
  type ReadVerifiedArtifactRequest,
  type ReadVerifiedArtifactResult,
} from "./protected.js";
import {
  parseExactRecord,
  parseNonEmptyString,
  parseNonNegativeSafeInteger,
} from "./validation.js";

/** The largest protected artifact accepted by the selected A1 local-state kernel. */
export const MAX_PROTECTED_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** Schema identifiers are bounded independently of the artifact payload. */
export const MAX_PROTECTED_ARTIFACT_SCHEMA_ID_UTF8_BYTES = 1024;

/** A bounded retry prevents a broken entropy source from looping forever. */
export const MAX_PROTECTED_ARTIFACT_ID_ATTEMPTS = 8;

export type ArtifactSqlValue = string | number | Uint8Array | null;

export interface ArtifactSqlRunResult {
  readonly changes: number;
}

/** Minimal synchronous SQL surface used inside one owner-state transaction. */
export interface ArtifactSqlTransaction {
  get(sql: string, parameters: readonly ArtifactSqlValue[]): unknown;
  run(sql: string, parameters: readonly ArtifactSqlValue[]): ArtifactSqlRunResult;
}

export interface ArtifactTransactionExecutor {
  transaction<T>(operation: (transaction: ArtifactSqlTransaction) => T): T;
}

export interface ProtectedArtifactRepositoryOptions {
  readonly randomBytes?: (byteLength: number) => Uint8Array;
  readonly nowMs?: () => number;
}

const FIND_ARTIFACT_SQL =
  "SELECT protected_handle_id FROM protected_artifacts WHERE protected_handle_id = ? LIMIT 1";
const INSERT_ARTIFACT_SQL = `INSERT INTO protected_artifacts (
  protected_handle_id,
  kind,
  scope_kind,
  scope_id,
  artifact_schema_id,
  artifact_digest,
  byte_length,
  artifact_bytes,
  created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const READ_ARTIFACT_SQL = `SELECT
  protected_handle_id,
  kind,
  scope_kind,
  scope_id,
  artifact_schema_id,
  artifact_digest,
  byte_length,
  artifact_bytes,
  created_at_ms
FROM protected_artifacts
WHERE protected_handle_id = ?
LIMIT 1`;

const PUT_REQUEST_KEYS = [
  "scopeKind",
  "scopeId",
  "artifactSchemaId",
  "artifactDigest",
  "artifactBytes",
] as const;
const READ_REQUEST_KEYS = [
  "scopeKind",
  "scopeId",
  "artifactRef",
  "artifactSchemaId",
  "expectedArtifactDigest",
] as const;
const ARTIFACT_ROW_KEYS = [
  "protected_handle_id",
  "kind",
  "scope_kind",
  "scope_id",
  "artifact_schema_id",
  "artifact_digest",
  "byte_length",
  "artifact_bytes",
  "created_at_ms",
] as const;

const READ_REJECTION = "protected artifact could not be verified";

export class ProtectedArtifactPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`protected artifact persistence failed: ${message}`, options);
    this.name = "ProtectedArtifactPersistenceError";
  }
}

function persistenceGet(
  transaction: ArtifactSqlTransaction,
  sql: string,
  parameters: readonly ArtifactSqlValue[],
): unknown {
  try {
    return transaction.get(sql, parameters);
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof ProtectedArtifactPersistenceError
    ) {
      throw error;
    }
    throw new ProtectedArtifactPersistenceError("read operation did not complete", {
      cause: error,
    });
  }
}

function persistenceRun(
  transaction: ArtifactSqlTransaction,
  sql: string,
  parameters: readonly ArtifactSqlValue[],
): ArtifactSqlRunResult {
  try {
    return transaction.run(sql, parameters);
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof ProtectedArtifactPersistenceError
    ) {
      throw error;
    }
    throw new ProtectedArtifactPersistenceError("write operation did not complete", {
      cause: error,
    });
  }
}

function reject(field: string, requirement: string): never {
  throw new HostStateContractError(`${field} ${requirement}`);
}

function rejectRead(): never {
  throw new HostStateContractError(READ_REJECTION);
}

function parseArtifactSchemaId(value: unknown, field: string): string {
  const schemaId = parseNonEmptyString(value, field);
  if (Buffer.byteLength(schemaId, "utf8") > MAX_PROTECTED_ARTIFACT_SCHEMA_ID_UTF8_BYTES) {
    reject(field, `must be at most ${MAX_PROTECTED_ARTIFACT_SCHEMA_ID_UTF8_BYTES} UTF-8 bytes`);
  }
  return schemaId;
}

function parseArtifactScope(scopeKind: unknown, scopeId: unknown): ProtectedOperationScope {
  return parseProtectedOperationScope(scopeKind, scopeId);
}

function equalDigest(left: A1Digest, right: A1Digest): boolean {
  return timingSafeEqual(base64urlDecode(left), base64urlDecode(right));
}

function digestArtifact(bytes: Uint8Array): A1Digest {
  return parseA1Digest(
    createHash("sha256").update(bytes).digest("base64url"),
    "computedArtifactDigest",
  );
}

function parseArtifactRef(value: unknown, field: string): ProtectedHandleRef<"artifact"> {
  let parsed: ReturnType<typeof parseProtectedHandleRef>;
  try {
    parsed = parseProtectedHandleRef(value);
  } catch {
    reject(field, "must be a valid artifact reference");
  }
  if (parsed.kind !== "artifact") {
    reject(field, "must be an artifact reference");
  }
  return parsed;
}

function sameScope(left: ProtectedOperationScope, right: ProtectedOperationScope): boolean {
  return left.scopeKind === right.scopeKind && left.scopeId === right.scopeId;
}

interface ParsedPutArtifact {
  readonly scope: ProtectedOperationScope;
  readonly artifactSchemaId: string;
  readonly artifactDigest: A1Digest;
  readonly artifactBytes: Uint8Array<ArrayBuffer>;
}

function parsePutArtifactRequest(request: PutArtifactRequest): ParsedPutArtifact {
  const record = parseExactRecord(request, PUT_REQUEST_KEYS, "putArtifact");
  const scope = parseArtifactScope(record.scopeKind, record.scopeId);
  const artifactSchemaId = parseArtifactSchemaId(
    record.artifactSchemaId,
    "putArtifact.artifactSchemaId",
  );
  const artifactDigest = parseA1Digest(record.artifactDigest, "putArtifact.artifactDigest");
  if (!(record.artifactBytes instanceof ProtectedByteSnapshot)) {
    reject("putArtifact.artifactBytes", "must be a protected byte snapshot");
  }
  if (record.artifactBytes.byteLength > MAX_PROTECTED_ARTIFACT_BYTES) {
    reject("putArtifact.artifactBytes", `must be at most ${MAX_PROTECTED_ARTIFACT_BYTES} bytes`);
  }
  const artifactBytes = record.artifactBytes.copyBytes();
  if (artifactBytes.byteLength !== record.artifactBytes.byteLength) {
    reject("putArtifact.artifactBytes", "changed while being copied");
  }
  return { scope, artifactSchemaId, artifactDigest, artifactBytes };
}

interface ParsedReadArtifact {
  readonly scope: ProtectedOperationScope;
  readonly artifactRef: ProtectedHandleRef<"artifact">;
  readonly artifactSchemaId: string;
  readonly expectedArtifactDigest: A1Digest;
}

function parseReadArtifactRequest(request: ReadVerifiedArtifactRequest): ParsedReadArtifact {
  const record = parseExactRecord(request, READ_REQUEST_KEYS, "readVerifiedArtifact");
  return {
    scope: parseArtifactScope(record.scopeKind, record.scopeId),
    artifactRef: parseArtifactRef(record.artifactRef, "readVerifiedArtifact.artifactRef"),
    artifactSchemaId: parseArtifactSchemaId(
      record.artifactSchemaId,
      "readVerifiedArtifact.artifactSchemaId",
    ),
    expectedArtifactDigest: parseA1Digest(
      record.expectedArtifactDigest,
      "readVerifiedArtifact.expectedArtifactDigest",
    ),
  };
}

interface StoredArtifactSnapshot {
  readonly scope: ProtectedOperationScope;
  readonly artifactRef: ProtectedHandleRef<"artifact">;
  readonly artifactSchemaId: string;
  readonly artifactDigest: A1Digest;
  readonly byteLength: number;
  readonly artifactBytes: Uint8Array<ArrayBuffer>;
}

function parseStoredArtifact(value: unknown): StoredArtifactSnapshot {
  const row = parseExactRecord(value, ARTIFACT_ROW_KEYS, "protectedArtifactRow");
  const artifactRef = parseArtifactRef(
    {
      protectedHandleId: row.protected_handle_id,
      kind: row.kind,
    },
    "protectedArtifactRow.artifactRef",
  );
  const scope = parseArtifactScope(row.scope_kind, row.scope_id);
  const artifactSchemaId = parseArtifactSchemaId(
    row.artifact_schema_id,
    "protectedArtifactRow.artifactSchemaId",
  );
  const artifactDigest = parseA1Digest(row.artifact_digest, "protectedArtifactRow.artifactDigest");
  const byteLength = parseNonNegativeSafeInteger(
    row.byte_length,
    "protectedArtifactRow.byteLength",
  );
  parseNonNegativeSafeInteger(row.created_at_ms, "protectedArtifactRow.createdAtMs");
  if (!(row.artifact_bytes instanceof Uint8Array)) {
    reject("protectedArtifactRow.artifactBytes", "must be bytes");
  }
  if (byteLength > MAX_PROTECTED_ARTIFACT_BYTES || row.artifact_bytes.byteLength !== byteLength) {
    reject("protectedArtifactRow.byteLength", "must match an artifact within the selected limit");
  }
  const artifactBytes = ProtectedByteSnapshot.from(row.artifact_bytes).copyBytes();
  return {
    scope,
    artifactRef,
    artifactSchemaId,
    artifactDigest,
    byteLength,
    artifactBytes,
  };
}

/**
 * Owner-only protected artifact storage. Bytes can leave storage only after the
 * caller's full scope, schema, reference, length, and digest claim verifies.
 */
export class ProtectedArtifactRepository implements ProtectedArtifactOperations {
  readonly #executor: ArtifactTransactionExecutor;
  readonly #randomBytes: (byteLength: number) => Uint8Array;
  readonly #nowMs: () => number;

  constructor(
    executor: ArtifactTransactionExecutor,
    options: ProtectedArtifactRepositoryOptions = {},
  ) {
    this.#executor = executor;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  async putArtifact(request: PutArtifactRequest): Promise<PutArtifactResult> {
    return this.#executor.transaction((transaction) =>
      createProtectedArtifactTransactionOperations(transaction, {
        randomBytes: this.#randomBytes,
        nowMs: this.#nowMs,
      }).putArtifact(request),
    );
  }

  async readVerifiedArtifact(
    request: ReadVerifiedArtifactRequest,
  ): Promise<ReadVerifiedArtifactResult> {
    return this.#executor.transaction((transaction) =>
      createProtectedArtifactTransactionOperations(transaction, {
        randomBytes: this.#randomBytes,
        nowMs: this.#nowMs,
      }).readVerifiedArtifact(request),
    );
  }
}

/** High-level operations exposed inside one synchronous host-state transaction. */
export interface ProtectedArtifactTransactionOperations {
  putArtifact(request: PutArtifactRequest): PutArtifactResult;
  readVerifiedArtifact(request: ReadVerifiedArtifactRequest): ReadVerifiedArtifactResult;
}

class BoundProtectedArtifactTransaction implements ProtectedArtifactTransactionOperations {
  readonly #transaction: ArtifactSqlTransaction;
  readonly #randomBytes: (byteLength: number) => Uint8Array;
  readonly #nowMs: () => number;

  constructor(
    transaction: ArtifactSqlTransaction,
    options: ProtectedArtifactRepositoryOptions = {},
  ) {
    this.#transaction = transaction;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  putArtifact(request: PutArtifactRequest): PutArtifactResult {
    const parsed = parsePutArtifactRequest(request);
    const computedDigest = digestArtifact(parsed.artifactBytes);
    if (!equalDigest(computedDigest, parsed.artifactDigest)) {
      reject("putArtifact.artifactDigest", "must match artifactBytes");
    }
    const createdAtMs = parseNonNegativeSafeInteger(this.#nowMs(), "putArtifact.createdAtMs");
    let protectedHandleId: ReturnType<typeof parseA1CanonicalId<"protectedHandle">> | undefined;
    for (let attempt = 0; attempt < MAX_PROTECTED_ARTIFACT_ID_ATTEMPTS; attempt++) {
      const entropy = this.#randomBytes(16);
      if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) {
        reject("putArtifact.randomBytes", "must return exactly 16 bytes");
      }
      const candidate = parseA1CanonicalId(
        "protectedHandle",
        `rcph_${base64urlEncode(entropy)}`,
        "putArtifact.artifactRef.protectedHandleId",
      );
      if (persistenceGet(this.#transaction, FIND_ARTIFACT_SQL, [candidate]) === undefined) {
        protectedHandleId = candidate;
        break;
      }
    }
    if (protectedHandleId === undefined) {
      reject(
        "putArtifact.artifactRef",
        `could not allocate a unique ID in ${MAX_PROTECTED_ARTIFACT_ID_ATTEMPTS} attempts`,
      );
    }

    const result = persistenceRun(this.#transaction, INSERT_ARTIFACT_SQL, [
      protectedHandleId,
      "artifact",
      parsed.scope.scopeKind,
      parsed.scope.scopeId,
      parsed.artifactSchemaId,
      parsed.artifactDigest,
      parsed.artifactBytes.byteLength,
      parsed.artifactBytes,
      createdAtMs,
    ]);
    if (result.changes !== 1) {
      throw new ProtectedArtifactPersistenceError(
        "write operation did not insert exactly one artifact",
      );
    }
    const artifactRef = parseArtifactRef(
      { protectedHandleId, kind: "artifact" },
      "putArtifact.artifactRef",
    );

    return Object.freeze({
      ...parsed.scope,
      artifactRef,
      artifactSchemaId: parsed.artifactSchemaId,
      artifactDigest: parsed.artifactDigest,
      byteLength: parsed.artifactBytes.byteLength,
    }) as PutArtifactResult;
  }

  readVerifiedArtifact(request: ReadVerifiedArtifactRequest): ReadVerifiedArtifactResult {
    let parsed: ParsedReadArtifact;
    try {
      parsed = parseReadArtifactRequest(request);
    } catch {
      rejectRead();
    }
    const row = persistenceGet(this.#transaction, READ_ARTIFACT_SQL, [
      parsed.artifactRef.protectedHandleId,
    ]);
    try {
      const stored = parseStoredArtifact(row);
      if (
        stored.artifactRef.protectedHandleId !== parsed.artifactRef.protectedHandleId ||
        !sameScope(stored.scope, parsed.scope) ||
        stored.artifactSchemaId !== parsed.artifactSchemaId ||
        !equalDigest(stored.artifactDigest, parsed.expectedArtifactDigest)
      ) {
        rejectRead();
      }
      const computedDigest = digestArtifact(stored.artifactBytes);
      if (!equalDigest(computedDigest, stored.artifactDigest)) {
        rejectRead();
      }

      return Object.freeze({
        ...stored.scope,
        artifactRef: stored.artifactRef,
        artifactSchemaId: stored.artifactSchemaId,
        artifactDigest: stored.artifactDigest,
        artifactBytes: ProtectedByteSnapshot.from(stored.artifactBytes),
      }) as ReadVerifiedArtifactResult;
    } catch {
      rejectRead();
    }
  }
}

export function createProtectedArtifactTransactionOperations(
  transaction: ArtifactSqlTransaction,
  options: ProtectedArtifactRepositoryOptions = {},
): ProtectedArtifactTransactionOperations {
  return new BoundProtectedArtifactTransaction(transaction, options);
}
