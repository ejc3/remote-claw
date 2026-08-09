import { createHash, timingSafeEqual } from "node:crypto";
import { CanonicalWriter } from "@remote-claw/clawsec";

/** SQLite application_id for the ASCII tag `RCLW`. */
export const HOST_STATE_APPLICATION_ID = 0x52434c57;

export const HOST_STATE_SCHEMA_VERSION = 2;

/** Domain for the length-framed, history-chained migration digest below. */
export const HOST_STATE_MIGRATION_DIGEST_DOMAIN = "remote-claw/host-state/migration-chain/v1";

export interface HostStateMigration {
  readonly version: number;
  readonly id: string;
  readonly statements: readonly string[];
}

export interface HostStateSqliteSchemaEntry {
  readonly type: "table" | "index" | "trigger" | "view";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

const CREATE_METADATA_SQL = `CREATE TABLE host_state_metadata (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  migration_digest TEXT NOT NULL CHECK (length(migration_digest) = 43),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT`;

const CREATE_MIGRATIONS_SQL = `CREATE TABLE host_state_migrations (
  schema_version INTEGER PRIMARY KEY NOT NULL CHECK (schema_version >= 1),
  migration_id TEXT NOT NULL,
  migration_digest TEXT NOT NULL CHECK (length(migration_digest) = 43),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT`;

const CREATE_MIGRATIONS_ID_INDEX_SQL = `CREATE UNIQUE INDEX host_state_migrations_id_unique
ON host_state_migrations (migration_id)`;

const CREATE_MIGRATIONS_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER host_state_migrations_no_update
BEFORE UPDATE ON host_state_migrations
BEGIN
  SELECT RAISE(ABORT, 'host state migration history is append-only');
END`;

const CREATE_MIGRATIONS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER host_state_migrations_no_delete
BEFORE DELETE ON host_state_migrations
BEGIN
  SELECT RAISE(ABORT, 'host state migration history is append-only');
END`;

const CREATE_MIGRATIONS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER host_state_migrations_no_replace
BEFORE INSERT ON host_state_migrations
WHEN EXISTS (
  SELECT 1 FROM host_state_migrations
  WHERE schema_version = NEW.schema_version OR migration_id = NEW.migration_id
)
BEGIN
  SELECT RAISE(ABORT, 'host state migration history is append-only');
END`;

const CREATE_PROTECTED_ARTIFACTS_SQL = `CREATE TABLE protected_artifacts (
  protected_handle_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'artifact'),
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN (
      'host_profile',
      'collaboration_server',
      'runtime',
      'native_binding',
      'native_attempt'
    )
  ),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 128),
  artifact_schema_id TEXT NOT NULL CHECK (length(artifact_schema_id) BETWEEN 1 AND 1024),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 43),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 16777216),
  artifact_bytes BLOB NOT NULL CHECK (length(artifact_bytes) = byte_length),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT, WITHOUT ROWID`;

const CREATE_PROTECTED_ARTIFACTS_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_no_update
BEFORE UPDATE ON protected_artifacts
BEGIN
  SELECT RAISE(ABORT, 'protected artifacts are immutable');
END`;

const CREATE_PROTECTED_ARTIFACTS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_no_delete
BEFORE DELETE ON protected_artifacts
BEGIN
  SELECT RAISE(ABORT, 'protected artifacts are immutable');
END`;

const CREATE_PROTECTED_ARTIFACTS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_no_replace
BEFORE INSERT ON protected_artifacts
WHEN EXISTS (
  SELECT 1 FROM protected_artifacts
  WHERE protected_handle_id = NEW.protected_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected artifacts are immutable');
END`;

const VERSION_ONE_STATEMENTS = Object.freeze([
  CREATE_METADATA_SQL,
  CREATE_MIGRATIONS_SQL,
  CREATE_MIGRATIONS_ID_INDEX_SQL,
  CREATE_MIGRATIONS_NO_UPDATE_TRIGGER_SQL,
  CREATE_MIGRATIONS_NO_DELETE_TRIGGER_SQL,
  CREATE_PROTECTED_ARTIFACTS_SQL,
] as const);

const VERSION_TWO_STATEMENTS = Object.freeze([
  CREATE_MIGRATIONS_NO_REPLACE_TRIGGER_SQL,
  CREATE_PROTECTED_ARTIFACTS_NO_UPDATE_TRIGGER_SQL,
  CREATE_PROTECTED_ARTIFACTS_NO_DELETE_TRIGGER_SQL,
  CREATE_PROTECTED_ARTIFACTS_NO_REPLACE_TRIGGER_SQL,
] as const);

export const HOST_STATE_MIGRATIONS: readonly HostStateMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    id: "001-initial-host-state",
    statements: VERSION_ONE_STATEMENTS,
  }),
  Object.freeze({
    version: 2,
    id: "002-protected-artifact-immutability",
    statements: VERSION_TWO_STATEMENTS,
  }),
]);

/**
 * Exact sqlite_schema rows produced by HOST_STATE_MIGRATIONS.
 *
 * The secure opener compares all four fields for every sqlite_schema row. The
 * explicit unique index avoids an implicit sqlite_autoindex, so no unlisted
 * SQLite-owned object is accepted.
 */
const VERSION_ONE_SQLITE_SCHEMA_MANIFEST: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  Object.freeze({
    type: "table",
    name: "host_state_metadata",
    tableName: "host_state_metadata",
    sql: CREATE_METADATA_SQL,
  }),
  Object.freeze({
    type: "table",
    name: "host_state_migrations",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_SQL,
  }),
  Object.freeze({
    type: "index",
    name: "host_state_migrations_id_unique",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_ID_INDEX_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "host_state_migrations_no_update",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_NO_UPDATE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "host_state_migrations_no_delete",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_NO_DELETE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "table",
    name: "protected_artifacts",
    tableName: "protected_artifacts",
    sql: CREATE_PROTECTED_ARTIFACTS_SQL,
  }),
]);

const VERSION_TWO_SQLITE_SCHEMA_MANIFEST: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  ...VERSION_ONE_SQLITE_SCHEMA_MANIFEST,
  Object.freeze({
    type: "trigger",
    name: "host_state_migrations_no_replace",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_NO_REPLACE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "protected_artifacts_no_update",
    tableName: "protected_artifacts",
    sql: CREATE_PROTECTED_ARTIFACTS_NO_UPDATE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "protected_artifacts_no_delete",
    tableName: "protected_artifacts",
    sql: CREATE_PROTECTED_ARTIFACTS_NO_DELETE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "protected_artifacts_no_replace",
    tableName: "protected_artifacts",
    sql: CREATE_PROTECTED_ARTIFACTS_NO_REPLACE_TRIGGER_SQL,
  }),
]);

export const HOST_STATE_SQLITE_SCHEMA_MANIFESTS: readonly (readonly HostStateSqliteSchemaEntry[])[] =
  Object.freeze([VERSION_ONE_SQLITE_SCHEMA_MANIFEST, VERSION_TWO_SQLITE_SCHEMA_MANIFEST]);

export function expectedHostStateSqliteSchemaManifest(
  schemaVersion: number,
): readonly HostStateSqliteSchemaEntry[] {
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > HOST_STATE_SQLITE_SCHEMA_MANIFESTS.length
  ) {
    migrationError(`schema version ${String(schemaVersion)} is not supported`);
  }
  const manifest = HOST_STATE_SQLITE_SCHEMA_MANIFESTS[schemaVersion - 1];
  if (manifest === undefined) migrationError(`schema version ${schemaVersion} has no manifest`);
  return manifest;
}

export const HOST_STATE_SQLITE_SCHEMA_MANIFEST =
  expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION);

function migrationError(requirement: string): never {
  throw new Error(`host state migration registry rejected: ${requirement}`);
}

export function assertHostStateMigrationRegistry(migrations: readonly HostStateMigration[]): void {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    migrationError("must contain at least one migration");
  }

  const ids = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (
      typeof migration !== "object" ||
      migration === null ||
      !Number.isSafeInteger(migration.version) ||
      migration.version !== expectedVersion
    ) {
      migrationError(`version ${expectedVersion} must be present exactly once and in order`);
    }
    if (typeof migration.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(migration.id)) {
      migrationError(`version ${expectedVersion} has an invalid migration id`);
    }
    if (ids.has(migration.id)) {
      migrationError(`migration id ${migration.id} is duplicated`);
    }
    ids.add(migration.id);

    if (!Array.isArray(migration.statements) || migration.statements.length === 0) {
      migrationError(`version ${expectedVersion} must contain at least one SQL statement`);
    }
    for (const statement of migration.statements) {
      if (typeof statement !== "string" || statement.length === 0 || statement.includes("\0")) {
        migrationError(`version ${expectedVersion} contains invalid SQL`);
      }
    }
  }
}

function digestWriter(writer: CanonicalWriter): Buffer {
  return createHash("sha256").update(writer.finish()).digest();
}

/**
 * Compute the digest after each migration.
 *
 * Each step commits the domain, the prior raw digest, version, migration id,
 * statement count, and the exact UTF-8 bytes of every SQL statement through
 * clawsec's selected canonical field writer.
 */
export function computeHostStateMigrationDigests(
  migrations: readonly HostStateMigration[],
): readonly string[] {
  assertHostStateMigrationRegistry(migrations);
  const genesis = new CanonicalWriter();
  genesis.str(HOST_STATE_MIGRATION_DIGEST_DOMAIN);
  genesis.str("genesis");
  let previous = digestWriter(genesis);
  const digests: string[] = [];

  for (const migration of migrations) {
    const writer = new CanonicalWriter();
    writer.str(HOST_STATE_MIGRATION_DIGEST_DOMAIN);
    writer.str("migration");
    writer.bytes(previous);
    writer.uint(migration.version);
    writer.str(migration.id);
    writer.uint(migration.statements.length);
    for (const statement of migration.statements) writer.str(statement);
    previous = digestWriter(writer);
    digests.push(previous.toString("base64url"));
  }

  return Object.freeze(digests);
}

if (HOST_STATE_MIGRATIONS.length !== HOST_STATE_SCHEMA_VERSION) {
  migrationError("declared schema version must equal the latest contiguous migration version");
}

export const HOST_STATE_MIGRATION_DIGESTS = computeHostStateMigrationDigests(HOST_STATE_MIGRATIONS);

export function expectedHostStateMigrationDigest(schemaVersion: number): string {
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > HOST_STATE_MIGRATION_DIGESTS.length
  ) {
    migrationError(`schema version ${String(schemaVersion)} is not supported`);
  }
  const digest = HOST_STATE_MIGRATION_DIGESTS[schemaVersion - 1];
  if (digest === undefined) migrationError(`schema version ${schemaVersion} has no digest`);
  return digest;
}

function canonicalDigestBytes(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) return null;
  return bytes;
}

export function isExpectedHostStateMigrationDigest(
  value: unknown,
  schemaVersion: number,
): value is string {
  const actual = canonicalDigestBytes(value);
  if (actual === null) return false;

  let expected: Buffer | null = null;
  try {
    expected = canonicalDigestBytes(expectedHostStateMigrationDigest(schemaVersion));
  } catch {
    return false;
  }
  return expected !== null && timingSafeEqual(actual, expected);
}

export const HOST_STATE_SCHEMA_MANIFEST = Object.freeze({
  applicationId: HOST_STATE_APPLICATION_ID,
  schemaVersion: HOST_STATE_SCHEMA_VERSION,
  migrationDigest: expectedHostStateMigrationDigest(HOST_STATE_SCHEMA_VERSION),
  sqliteSchema: HOST_STATE_SQLITE_SCHEMA_MANIFEST,
});
