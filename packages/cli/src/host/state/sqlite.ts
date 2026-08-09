import { closeSync, constants as FS, fstatSync, openSync, readSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isPromise, isProxy } from "node:util/types";
import {
  type ArtifactSqlRunResult,
  type ArtifactSqlTransaction,
  type ArtifactSqlValue,
  type ArtifactTransactionExecutor,
  createProtectedArtifactTransactionOperations,
  ProtectedArtifactPersistenceError,
  ProtectedArtifactRepository,
  type ProtectedArtifactTransactionOperations,
} from "./artifacts.js";
import { HostStateContractError, parseMachineIdentityId } from "./ids.js";
import {
  expectedHostStateMigrationDigest,
  expectedHostStateSqliteSchemaManifest,
  HOST_STATE_APPLICATION_ID,
  HOST_STATE_MIGRATIONS,
  HOST_STATE_SCHEMA_MANIFEST,
  HOST_STATE_SCHEMA_VERSION,
  isExpectedHostStateMigrationDigest,
} from "./migrations.js";
import { type HostStatePathEnvironment, resolveHostStatePaths } from "./path.js";
import type {
  ProtectedArtifactOperations,
  PutArtifactRequest,
  PutArtifactResult,
  ReadVerifiedArtifactRequest,
  ReadVerifiedArtifactResult,
} from "./protected.js";
import {
  openSecureHostStateFilesystem,
  type SecureHostStateFilesystem,
} from "./secure-filesystem.js";

export {
  MAX_PROTECTED_ARTIFACT_BYTES,
  MAX_PROTECTED_ARTIFACT_ID_ATTEMPTS,
  MAX_PROTECTED_ARTIFACT_SCHEMA_ID_UTF8_BYTES,
  ProtectedArtifactPersistenceError,
} from "./artifacts.js";

export const HOST_STATE_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;

export class HostStateStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`host state storage rejected: ${message}`, options);
    this.name = "HostStateStorageError";
  }
}

export class HostStateCommittedStateError extends HostStateStorageError {
  readonly committed = true;
  readonly retrySafe = false;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostStateCommittedStateError";
  }
}

export class HostStateCommitOutcomeUnknownError extends HostStateStorageError {
  readonly outcome = "unknown" as const;
  readonly retrySafe = false;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostStateCommitOutcomeUnknownError";
  }
}

export class HostStateMigrationCommittedError extends HostStateStorageError {
  readonly committed = true;
  readonly retryOpenSafe = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostStateMigrationCommittedError";
  }
}

export class HostStateMigrationOutcomeUnknownError extends HostStateStorageError {
  readonly outcome = "unknown" as const;
  readonly retryOpenSafe = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostStateMigrationOutcomeUnknownError";
  }
}

export class HostStateCloseIncompleteError extends HostStateStorageError {
  readonly guardiansRetained = true;
  readonly retryCloseSafe = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostStateCloseIncompleteError";
  }
}

export class HostStateOpenCleanupError extends HostStateStorageError {
  readonly guardiansRetained = true;
  readonly retryOpenSafe = false;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostStateOpenCleanupError";
  }
}

/** Runtime counterpart to the advisory package `engines` range. */
export function assertHostStateNodeVersion(version: string = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) reject("Node.js version could not be verified");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = (major === 22 && minor >= 13) || (major === 23 && minor >= 5) || major >= 24;
  if (!supported) {
    reject("secure host state requires Node.js ^22.13.0 or >=23.5.0");
  }
}

export interface OpenHostStateDatabaseOptions {
  readonly machineIdentityId: string;
  readonly pathEnvironment?: HostStatePathEnvironment;
}

/**
 * The dormant A1.1 surface. It exposes only protected artifact operations and
 * lifecycle metadata; SQLite and arbitrary SQL remain private to the kernel.
 */
export interface HostStateDatabase extends ProtectedArtifactOperations {
  readonly machineIdentityId: string;
  readonly databasePath: string;
  readonly schemaVersion: typeof HOST_STATE_SCHEMA_VERSION;
  transaction<T>(operation: (transaction: HostStateTransaction) => T): T;
  close(): void;
}

/** High-level operations available atomically; no SQL handle crosses this boundary. */
export type HostStateTransaction = ProtectedArtifactTransactionOperations;

type SqliteRow = Readonly<Record<string, unknown>>;

interface QuarantinedOpenFailure {
  readonly databases: readonly DatabaseSync[];
  readonly filesystem: SecureHostStateFilesystem;
}

// If SQLite refuses to close after an open failure, retaining these objects is
// safer than dropping the descriptor guardians while a live connection still
// owns the canonical database and sidecars. The runtime owner must restart to
// release such a fail-stop quarantine.
const QUARANTINED_OPEN_FAILURES = new Map<string, QuarantinedOpenFailure>();

function reject(message: string, cause?: unknown): never {
  throw new HostStateStorageError(message, cause === undefined ? undefined : { cause });
}

function databaseRemainsOpenAfterCloseError(database: DatabaseSync): boolean {
  try {
    const state = (database as DatabaseSync & { readonly isOpen?: unknown }).isOpen;
    return typeof state === "boolean" ? state : true;
  } catch {
    return true;
  }
}

function closeDatabaseForCleanup(database: DatabaseSync, errors: unknown[]): boolean {
  try {
    database.close();
    return true;
  } catch (error) {
    errors.push(error);
  }
  const remainsOpen = databaseRemainsOpenAfterCloseError(database);
  if (remainsOpen) errors.push(new Error("SQLite connection remained open after close"));
  return !remainsOpen;
}

function hasThenWithoutUserCode(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    if (isProxy(current)) {
      throw new HostStateStorageError("transaction callback result could not be inspected safely");
    }
    if (Object.getOwnPropertyDescriptor(current, "then") !== undefined) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function isRecord(value: unknown): value is SqliteRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownData(value: SqliteRow, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    reject(`SQLite did not return the required ${key} field`);
  }
  return descriptor.value;
}

function pragmaValue(database: DatabaseSync, pragma: string, key: string): unknown {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (!isRecord(row)) reject(`PRAGMA ${pragma} returned no row`);
  return ownData(row, key);
}

function requirePragma(
  database: DatabaseSync,
  pragma: string,
  key: string,
  expected: string | number,
): void {
  const actual = pragmaValue(database, pragma, key);
  if (actual !== expected) {
    reject(`PRAGMA ${pragma} must equal ${JSON.stringify(expected)}`);
  }
}

function assertDatabaseLocation(database: DatabaseSync, expectedPath: string): void {
  const rows = database.prepare("PRAGMA database_list").all();
  if (rows.length !== 1 || !isRecord(rows[0])) {
    reject("SQLite must expose exactly one main database");
  }
  const row = rows[0];
  if (
    ownData(row, "seq") !== 0 ||
    ownData(row, "name") !== "main" ||
    ownData(row, "file") !== expectedPath
  ) {
    reject("SQLite main database does not resolve to the guarded database path");
  }
}

function assertDoubleQuotedStringLiteralsDisabled(database: DatabaseSync): void {
  try {
    database.prepare('SELECT "remote_claw_dqs_probe"').get();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "ERR_SQLITE_ERROR" &&
      Object.getOwnPropertyDescriptor(error, "errcode")?.value === 1
    ) {
      const row = database.prepare("SELECT 'remote_claw_dqs_probe' AS value").get();
      if (isRecord(row) && ownData(row, "value") === "remote_claw_dqs_probe") return;
    }
    reject("SQLite double-quoted-string behavior could not be verified", error);
  }
  reject("SQLite double-quoted string literals must be disabled");
}

function setConnectionPosture(database: DatabaseSync, newDatabase: boolean): void {
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA trusted_schema=OFF");
  database.exec(`PRAGMA busy_timeout=${HOST_STATE_SQLITE_BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA temp_store=MEMORY");
  database.exec("PRAGMA recursive_triggers=ON");

  if (newDatabase) {
    const selected = database.prepare("PRAGMA journal_mode=WAL").get();
    if (!isRecord(selected) || ownData(selected, "journal_mode") !== "wal") {
      reject("new database could not enter WAL mode");
    }
  } else {
    requirePragma(database, "journal_mode", "journal_mode", "wal");
    const selected = database.prepare("PRAGMA journal_mode=WAL").get();
    if (!isRecord(selected) || ownData(selected, "journal_mode") !== "wal") {
      reject("existing database did not remain in WAL mode");
    }
  }
  database.exec("PRAGMA synchronous=FULL");

  requirePragma(database, "foreign_keys", "foreign_keys", 1);
  requirePragma(database, "trusted_schema", "trusted_schema", 0);
  requirePragma(database, "journal_mode", "journal_mode", "wal");
  requirePragma(database, "synchronous", "synchronous", 2);
  requirePragma(database, "busy_timeout", "timeout", HOST_STATE_SQLITE_BUSY_TIMEOUT_MS);
  requirePragma(database, "temp_store", "temp_store", 2);
  requirePragma(database, "recursive_triggers", "recursive_triggers", 1);
}

function setReadOnlyConnectionPosture(database: DatabaseSync): void {
  database.exec("PRAGMA query_only=ON");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA trusted_schema=OFF");
  database.exec(`PRAGMA busy_timeout=${HOST_STATE_SQLITE_BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA temp_store=MEMORY");
  database.exec("PRAGMA recursive_triggers=ON");
  database.exec("PRAGMA synchronous=FULL");

  requirePragma(database, "query_only", "query_only", 1);
  requirePragma(database, "foreign_keys", "foreign_keys", 1);
  requirePragma(database, "trusted_schema", "trusted_schema", 0);
  requirePragma(database, "journal_mode", "journal_mode", "wal");
  requirePragma(database, "synchronous", "synchronous", 2);
  requirePragma(database, "busy_timeout", "timeout", HOST_STATE_SQLITE_BUSY_TIMEOUT_MS);
  requirePragma(database, "temp_store", "temp_store", 2);
  requirePragma(database, "recursive_triggers", "recursive_triggers", 1);
}

function preflightExistingDatabaseHeader(
  databaseDescriptorPath: string,
  databaseWasCreated: boolean,
  facts: Readonly<{ existingWalByteLength: number }>,
): void {
  if (databaseWasCreated) return;
  if (!Number.isSafeInteger(facts.existingWalByteLength) || facts.existingWalByteLength < 0) {
    reject("existing WAL length could not be verified");
  }
  let fd: number | undefined;
  try {
    fd = openSync(databaseDescriptorPath, FS.O_RDONLY);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 100) {
      reject("an existing database must contain a complete SQLite header");
    }
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.byteLength, 0) !== header.byteLength) {
      reject("an existing database has a truncated SQLite header");
    }
    if (!header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "ascii"))) {
      reject("an existing database has an invalid SQLite header");
    }
    if (header[18] !== 2 || header[19] !== 2) {
      reject("an existing database is not a WAL database");
    }
    // A committed crash-surviving WAL may carry newer header fields than the
    // main file. Let SQLite recover and validate that case; raw main-header
    // application/version fields are authoritative only without WAL content.
    if (facts.existingWalByteLength > 0) return;
    if (header.readUInt32BE(68) !== HOST_STATE_APPLICATION_ID) {
      reject(`application_id must equal ${HOST_STATE_APPLICATION_ID}`);
    }
    const schemaVersion = header.readUInt32BE(60);
    if (schemaVersion === 0) reject("an existing database is partial or uninitialized");
    if (schemaVersion > HOST_STATE_SCHEMA_VERSION) {
      reject(`schema version ${schemaVersion} is newer than this build supports`);
    }
  } catch (error) {
    if (error instanceof HostStateStorageError) throw error;
    reject("could not inspect the existing database header", error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    reject(`${field} must be a safe integer at least ${minimum}`);
  }
  return value as number;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") reject(`${field} must be a string`);
  return value;
}

function checkpointAndSync(database: DatabaseSync, filesystem: SecureHostStateFilesystem): void {
  filesystem.assertStable();
  const row = database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
  if (!isRecord(row)) reject("WAL checkpoint returned no result");
  const busy = safeInteger(ownData(row, "busy"), "WAL checkpoint busy");
  const log = safeInteger(ownData(row, "log"), "WAL checkpoint log count");
  const checkpointed = safeInteger(ownData(row, "checkpointed"), "WAL checkpoint completed count");
  if (busy > 1 || checkpointed > log) reject("WAL checkpoint returned inconsistent counts");
  // FULL WAL COMMIT is the durability boundary. A passive checkpoint is
  // deliberately non-blocking: an active reader may defer copying frames, but
  // that must not turn an already committed migration into an apparent
  // rollback. Fsync every guarded inode and directory in either case.
  filesystem.fsync();
}

function rollback(database: DatabaseSync): boolean {
  try {
    database.exec("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

function validatePristineDatabase(database: DatabaseSync): void {
  if (pragmaValue(database, "application_id", "application_id") !== 0) {
    reject("new database application_id must remain zero before migration 1");
  }
  const rows = database.prepare("SELECT name FROM sqlite_schema").all();
  if (rows.length !== 0) {
    reject("new database acquired application schema before migration 1");
  }
}

function applyPendingMigrations(
  database: DatabaseSync,
  filesystem: SecureHostStateFilesystem,
  machineIdentityId: string,
  createdAtMs: number,
  fromSchemaVersion: number,
): void {
  for (const migration of HOST_STATE_MIGRATIONS.slice(fromSchemaVersion)) {
    filesystem.assertStable();
    database.exec("BEGIN IMMEDIATE");
    let commitAttempted = false;
    let committed = false;
    try {
      filesystem.assertStable();
      const lockedVersion = safeInteger(
        pragmaValue(database, "user_version", "user_version"),
        "user_version",
      );
      if (lockedVersion >= migration.version) {
        // Another opener may have applied this migration and multiple compiled
        // successors while this opener waited for the writer lock. Accept only
        // that exact, fully validated concurrent completion.
        validateDatabaseAtVersion(database, filesystem, machineIdentityId, lockedVersion);
        database.exec("ROLLBACK");
        filesystem.assertStable();
        continue;
      }
      if (lockedVersion !== migration.version - 1) {
        reject(
          `locked schema version ${lockedVersion} cannot apply migration ${migration.version}`,
        );
      }
      if (lockedVersion === 0) {
        validatePristineDatabase(database);
      } else {
        validateDatabaseAtVersion(database, filesystem, machineIdentityId, lockedVersion);
      }
      for (const statement of migration.statements) database.exec(statement);
      const migrationDigest = expectedHostStateMigrationDigest(migration.version);
      database
        .prepare(
          `INSERT INTO host_state_migrations
             (schema_version, migration_id, migration_digest, applied_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(migration.version, migration.id, migrationDigest, createdAtMs);
      if (migration.version === 1) {
        database
          .prepare(
            `INSERT INTO host_state_metadata
               (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
             VALUES (1, ?, ?, ?, ?)`,
          )
          .run(machineIdentityId, migration.version, migrationDigest, createdAtMs);
        database.exec(`PRAGMA application_id=${HOST_STATE_APPLICATION_ID}`);
      } else {
        database
          .prepare(
            `UPDATE host_state_metadata
             SET schema_version = ?, migration_digest = ?
             WHERE singleton = 1`,
          )
          .run(migration.version, migrationDigest);
      }
      database.exec(`PRAGMA user_version=${migration.version}`);
      filesystem.assertStable();
      commitAttempted = true;
      database.exec("COMMIT");
      committed = true;
    } catch (error) {
      const rolledBack = rollback(database);
      if (commitAttempted && !rolledBack) {
        throw new HostStateMigrationOutcomeUnknownError(
          `migration ${migration.version} COMMIT outcome is unknown; reopening is safe`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      filesystem.assertStable();
      validateDatabaseAtVersionSnapshot(database, filesystem, machineIdentityId, migration.version);
      checkpointAndSync(database, filesystem);
    } catch (error) {
      if (!committed) throw error;
      throw new HostStateMigrationCommittedError(
        `migration ${migration.version} committed, but post-commit finalization failed; reopening is safe`,
        { cause: error },
      );
    }
  }
}

function validateApplicationIdentity(database: DatabaseSync): number {
  const applicationId = safeInteger(
    pragmaValue(database, "application_id", "application_id"),
    "application_id",
  );
  if (applicationId !== HOST_STATE_APPLICATION_ID) {
    reject(`application_id must equal ${HOST_STATE_APPLICATION_ID}`);
  }
  const schemaVersion = safeInteger(
    pragmaValue(database, "user_version", "user_version"),
    "user_version",
  );
  if (schemaVersion === 0) reject("an existing database is partial or uninitialized");
  if (schemaVersion > HOST_STATE_SCHEMA_VERSION) {
    reject(`schema version ${schemaVersion} is newer than this build supports`);
  }
  return schemaVersion;
}

function validateMetadata(
  database: DatabaseSync,
  machineIdentityId: string,
  schemaVersion: number,
): void {
  const rows = database
    .prepare(
      `SELECT singleton, machine_identity_id, schema_version, migration_digest, created_at_ms
       FROM host_state_metadata`,
    )
    .all();
  if (rows.length !== 1 || !isRecord(rows[0])) reject("metadata must contain exactly one row");
  const row = rows[0];
  if (ownData(row, "singleton") !== 1) reject("metadata singleton is invalid");
  if (
    stringValue(ownData(row, "machine_identity_id"), "stored machine identity") !==
    machineIdentityId
  ) {
    reject("stored machine identity does not match the selected identity");
  }
  if (safeInteger(ownData(row, "schema_version"), "metadata schema version", 1) !== schemaVersion) {
    reject("metadata schema version does not match user_version");
  }
  const digest = ownData(row, "migration_digest");
  if (!isExpectedHostStateMigrationDigest(digest, schemaVersion)) {
    reject("metadata migration digest does not match the compiled registry");
  }
  safeInteger(ownData(row, "created_at_ms"), "metadata creation time");
}

function validateMigrationHistory(database: DatabaseSync, schemaVersion: number): void {
  const rows = database
    .prepare(
      `SELECT schema_version, migration_id, migration_digest, applied_at_ms
       FROM host_state_migrations
       ORDER BY schema_version`,
    )
    .all();
  if (rows.length !== schemaVersion) reject("migration history is incomplete or has extra rows");
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const migration = HOST_STATE_MIGRATIONS[index];
    if (!isRecord(row) || migration === undefined) reject("migration history is invalid");
    if (ownData(row, "schema_version") !== migration.version) {
      reject("migration history versions are not contiguous");
    }
    if (ownData(row, "migration_id") !== migration.id) reject("migration ID does not match");
    if (!isExpectedHostStateMigrationDigest(ownData(row, "migration_digest"), migration.version)) {
      reject("migration digest does not match the compiled registry");
    }
    safeInteger(ownData(row, "applied_at_ms"), "migration application time");
  }
}

function validateSqliteSchema(database: DatabaseSync, schemaVersion: number): void {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       ORDER BY type, name`,
    )
    .all();
  const expected = [...expectedHostStateSqliteSchemaManifest(schemaVersion)].sort((left, right) =>
    left.type === right.type
      ? left.name < right.name
        ? -1
        : left.name > right.name
          ? 1
          : 0
      : left.type < right.type
        ? -1
        : 1,
  );
  if (rows.length !== expected.length)
    reject("SQLite schema manifest has missing or extra objects");
  for (let index = 0; index < expected.length; index++) {
    const row = rows[index];
    const manifest = expected[index];
    if (!isRecord(row) || manifest === undefined) reject("SQLite schema manifest is invalid");
    if (
      ownData(row, "type") !== manifest.type ||
      ownData(row, "name") !== manifest.name ||
      ownData(row, "tableName") !== manifest.tableName ||
      ownData(row, "sql") !== manifest.sql
    ) {
      reject(`SQLite schema object ${manifest.name} does not match the compiled manifest`);
    }
  }
}

function validateIntegrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA integrity_check").all();
  if (rows.length !== 1 || !isRecord(rows[0]) || ownData(rows[0], "integrity_check") !== "ok") {
    reject("SQLite integrity_check failed");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    reject("SQLite foreign_key_check failed");
  }
}

function validateDatabaseAtVersion(
  database: DatabaseSync,
  filesystem: SecureHostStateFilesystem,
  machineIdentityId: string,
  expectedSchemaVersion: number,
): void {
  filesystem.assertStable();
  const schemaVersion = validateApplicationIdentity(database);
  if (schemaVersion !== expectedSchemaVersion) {
    reject(`schema version ${schemaVersion} does not match expected ${expectedSchemaVersion}`);
  }
  validateDatabaseContentsAtVersion(database, machineIdentityId, schemaVersion);
  filesystem.assertStable();
}

function validateDatabaseContentsAtVersion(
  database: DatabaseSync,
  machineIdentityId: string,
  schemaVersion: number,
): void {
  // Approve the exact compiled schema before selecting from any application
  // object; a corrupt database must not substitute a view at a trusted name.
  validateSqliteSchema(database, schemaVersion);
  validateMetadata(database, machineIdentityId, schemaVersion);
  validateMigrationHistory(database, schemaVersion);
  validateIntegrity(database);
  if (HOST_STATE_SCHEMA_MANIFEST.applicationId !== HOST_STATE_APPLICATION_ID) {
    reject("compiled schema manifest is internally inconsistent");
  }
}

function validateDatabaseAtVersionSnapshot(
  database: DatabaseSync,
  filesystem: SecureHostStateFilesystem,
  machineIdentityId: string,
  expectedSchemaVersion: number,
): void {
  filesystem.assertStable();
  database.exec("BEGIN");
  try {
    validateDatabaseAtVersion(database, filesystem, machineIdentityId, expectedSchemaVersion);
    database.exec("ROLLBACK");
  } catch (error) {
    rollback(database);
    throw error;
  }
  filesystem.assertStable();
}

function openValidatedExistingDatabaseReadOnly(
  filesystem: SecureHostStateFilesystem,
  databasePath: string,
  machineIdentityId: string,
  opened: (database: DatabaseSync) => void,
): Readonly<{ database: DatabaseSync; schemaVersion: number }> {
  filesystem.assertStable();
  const database = new DatabaseSync(filesystem.databaseDescriptorPath, {
    open: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    readOnly: true,
    allowExtension: false,
  });
  opened(database);
  assertDatabaseLocation(database, databasePath);
  assertDoubleQuotedStringLiteralsDisabled(database);
  setReadOnlyConnectionPosture(database);

  database.exec("BEGIN");
  let schemaVersion: number;
  try {
    schemaVersion = validateApplicationIdentity(database);
    validateDatabaseContentsAtVersion(database, machineIdentityId, schemaVersion);
    database.exec("ROLLBACK");
  } catch (error) {
    rollback(database);
    throw error;
  }
  filesystem.assertStable();
  return Object.freeze({ database, schemaVersion });
}

function statement(database: DatabaseSync, sql: string): StatementSync {
  try {
    return database.prepare(sql);
  } catch (error) {
    reject("could not prepare an internal statement", error);
  }
}

class ActiveArtifactSqlTransaction implements ArtifactSqlTransaction {
  readonly #database: DatabaseSync;
  #active = true;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  invalidate(): void {
    this.#active = false;
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new HostStateContractError("hostState.transaction object escaped its callback");
    }
  }

  get(sql: string, parameters: readonly ArtifactSqlValue[]): unknown {
    this.#assertActive();
    return statement(this.#database, sql).get(...parameters);
  }

  run(sql: string, parameters: readonly ArtifactSqlValue[]): ArtifactSqlRunResult {
    this.#assertActive();
    const result = statement(this.#database, sql).run(...parameters);
    return Object.freeze({ changes: Number(result.changes) });
  }
}

class SqliteArtifactTransactionExecutor implements ArtifactTransactionExecutor {
  readonly #database: DatabaseSync;
  readonly #filesystem: SecureHostStateFilesystem;
  #closed = false;
  #inTransaction = false;
  #poisoned = false;

  constructor(database: DatabaseSync, filesystem: SecureHostStateFilesystem) {
    this.#database = database;
    this.#filesystem = filesystem;
  }

  assertUsable(): void {
    if (this.#closed) reject("database is closed");
    if (this.#poisoned) reject("database handle is poisoned");
  }

  assertStandaloneUsable(): void {
    this.assertUsable();
    if (this.#inTransaction) {
      reject("database-level artifact operations cannot run inside a transaction callback");
    }
  }

  transaction<T>(operation: (transaction: ArtifactSqlTransaction) => T): T {
    this.assertUsable();
    if (this.#inTransaction) reject("nested transactions are not supported");
    if (typeof operation !== "function") reject("transaction callback must be a function");
    this.#filesystem.assertStable();
    this.#inTransaction = true;
    const transaction = new ActiveArtifactSqlTransaction(this.#database);
    let began = false;
    let commitAttempted = false;
    let committed = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      began = true;
      this.#filesystem.assertStable();
      const result = operation(transaction);
      if (isPromise(result)) {
        // The callback has already created a native promise. Observe any late
        // rejection without invoking its `then` property. Poison first because
        // Promise species construction can itself be hostile or reentrant.
        this.#poisoned = true;
        try {
          Reflect.apply(INTRINSIC_PROMISE_THEN, result, [undefined, () => undefined]);
        } catch (error) {
          throw new HostStateStorageError("transaction callback must be synchronous", {
            cause: error,
          });
        }
        reject("transaction callback must be synchronous");
      }
      let hasThen: boolean;
      try {
        hasThen =
          (typeof result === "object" && result !== null) || typeof result === "function"
            ? hasThenWithoutUserCode(result as object)
            : false;
      } catch (error) {
        this.#poisoned = true;
        if (error instanceof HostStateStorageError) throw error;
        throw new HostStateStorageError(
          "transaction callback result could not be inspected safely",
          { cause: error },
        );
      }
      if (hasThen) {
        this.#poisoned = true;
        reject("transaction callback must be synchronous");
      }
      this.#filesystem.assertStable();
      commitAttempted = true;
      this.#database.exec("COMMIT");
      committed = true;
      // `synchronous=FULL` makes COMMIT the transaction's durability boundary.
      // Do not add a fallible checkpoint/fsync after it: a concurrent reader may
      // legitimately defer a checkpoint, and reporting failure after COMMIT
      // would invite an unsafe retry of a write that already landed.
      try {
        this.#filesystem.assertStable();
      } catch (error) {
        throw new HostStateCommittedStateError(
          "transaction committed, but guarded state changed before post-commit verification",
          { cause: error },
        );
      }
      return result;
    } catch (error) {
      if (error instanceof ProtectedArtifactPersistenceError) this.#poisoned = true;
      if (began && !committed && !rollback(this.#database)) this.#poisoned = true;
      if (commitAttempted || committed) this.#poisoned = true;
      try {
        this.#filesystem.assertStable();
      } catch {
        this.#poisoned = true;
      }
      if (commitAttempted && !committed) {
        throw new HostStateCommitOutcomeUnknownError(
          "transaction COMMIT failed with an outcome that must not be retried blindly",
          { cause: error },
        );
      }
      throw error;
    } finally {
      transaction.invalidate();
      this.#inTransaction = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#inTransaction) reject("cannot close during a transaction");
    this.#closed = true;
  }

  poison(): void {
    this.#poisoned = true;
  }
}

class SqliteHostStateDatabase implements HostStateDatabase {
  readonly machineIdentityId: string;
  readonly databasePath: string;
  readonly schemaVersion = HOST_STATE_SCHEMA_VERSION;
  readonly #database: DatabaseSync;
  readonly #filesystem: SecureHostStateFilesystem;
  readonly #executor: SqliteArtifactTransactionExecutor;
  readonly #artifacts: ProtectedArtifactRepository;
  #closing = false;
  #closed = false;

  constructor(
    machineIdentityId: string,
    databasePath: string,
    database: DatabaseSync,
    filesystem: SecureHostStateFilesystem,
  ) {
    this.machineIdentityId = machineIdentityId;
    this.databasePath = databasePath;
    this.#database = database;
    this.#filesystem = filesystem;
    this.#executor = new SqliteArtifactTransactionExecutor(database, filesystem);
    this.#artifacts = new ProtectedArtifactRepository(this.#executor);
    Object.freeze(this);
  }

  putArtifact(request: PutArtifactRequest): Promise<PutArtifactResult> {
    this.#executor.assertStandaloneUsable();
    return this.#artifacts.putArtifact(request);
  }

  readVerifiedArtifact(request: ReadVerifiedArtifactRequest): Promise<ReadVerifiedArtifactResult> {
    this.#executor.assertStandaloneUsable();
    return this.#artifacts.readVerifiedArtifact(request);
  }

  transaction<T>(operation: (transaction: HostStateTransaction) => T): T {
    this.#executor.assertUsable();
    if (typeof operation !== "function") reject("transaction callback must be a function");
    return this.#executor.transaction((transaction) =>
      operation(createProtectedArtifactTransactionOperations(transaction) as HostStateTransaction),
    );
  }

  close(): void {
    if (this.#closed) return;
    if (this.#closing) reject("database close is already in progress");
    this.#executor.close();
    this.#closing = true;
    let firstError: unknown;
    try {
      this.#filesystem.assertStable();
    } catch (error) {
      this.#executor.poison();
      firstError = error;
    }
    try {
      this.#database.close();
    } catch (error) {
      firstError ??= error;
      if (databaseRemainsOpenAfterCloseError(this.#database)) {
        this.#closing = false;
        throw new HostStateCloseIncompleteError(
          "SQLite close did not complete; descriptor guardians remain held and close may be retried",
          firstError === undefined ? undefined : { cause: firstError },
        );
      }
    }
    try {
      this.#filesystem.close();
    } catch (error) {
      firstError ??= error;
    }
    this.#closed = true;
    this.#closing = false;
    if (firstError !== undefined) throw firstError;
  }
}

/** Open the dormant A1.1 local-state kernel. No active CLI path imports this function. */
export function openHostStateDatabase(options: OpenHostStateDatabaseOptions): HostStateDatabase {
  assertHostStateNodeVersion();
  const machineIdentityId = parseMachineIdentityId(options.machineIdentityId);
  const paths = resolveHostStatePaths(machineIdentityId, options.pathEnvironment);
  if (QUARANTINED_OPEN_FAILURES.has(paths.databasePath)) {
    throw new HostStateOpenCleanupError(
      "database is quarantined after an incomplete open cleanup; process restart is required",
    );
  }
  const createdAtMs = Date.now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new HostStateContractError("hostState.createdAtMs must be a non-negative safe integer");
  }
  const filesystem = openSecureHostStateFilesystem(paths.databasePath, {
    preflightDatabase: preflightExistingDatabaseHeader,
  });
  let validationDatabase: DatabaseSync | undefined;
  let database: DatabaseSync | undefined;
  try {
    filesystem.assertStable();
    const existingSchemaVersion = filesystem.databaseWasCreated
      ? 0
      : (() => {
          const validated = openValidatedExistingDatabaseReadOnly(
            filesystem,
            paths.databasePath,
            machineIdentityId,
            (opened) => {
              validationDatabase = opened;
            },
          );
          return validated.schemaVersion;
        })();
    database = new DatabaseSync(filesystem.databaseDescriptorPath, {
      open: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      readOnly: false,
      allowExtension: false,
    });
    assertDatabaseLocation(database, paths.databasePath);
    assertDoubleQuotedStringLiteralsDisabled(database);
    setConnectionPosture(database, filesystem.databaseWasCreated);
    filesystem.assertStable();
    applyPendingMigrations(
      database,
      filesystem,
      machineIdentityId,
      createdAtMs,
      existingSchemaVersion,
    );
    validateDatabaseAtVersionSnapshot(
      database,
      filesystem,
      machineIdentityId,
      HOST_STATE_SCHEMA_VERSION,
    );
    validationDatabase?.close();
    validationDatabase = undefined;
    return new SqliteHostStateDatabase(machineIdentityId, paths.databasePath, database, filesystem);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const remaining: DatabaseSync[] = [];
    // Writable must close before the read-only last-close anchor.
    for (const candidate of [database, validationDatabase]) {
      if (candidate !== undefined && !closeDatabaseForCleanup(candidate, cleanupErrors)) {
        remaining.push(candidate);
      }
    }
    if (remaining.length > 0) {
      QUARANTINED_OPEN_FAILURES.set(
        paths.databasePath,
        Object.freeze({ databases: Object.freeze(remaining), filesystem }),
      );
      throw new HostStateOpenCleanupError(
        "open failed and a SQLite connection remained live; descriptor guardians are retained until process restart",
        { cause: new AggregateError([error, ...cleanupErrors]) },
      );
    }
    try {
      filesystem.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new HostStateStorageError("open failed and cleanup also failed", {
        cause: new AggregateError([error, ...cleanupErrors]),
      });
    }
    throw error;
  }
}
