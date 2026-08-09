import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertHostStateMigrationRegistry,
  computeHostStateMigrationDigests,
  expectedHostStateMigrationDigest,
  expectedHostStateSqliteSchemaManifest,
  HOST_STATE_APPLICATION_ID,
  HOST_STATE_MIGRATION_DIGESTS,
  HOST_STATE_MIGRATIONS,
  HOST_STATE_SCHEMA_MANIFEST,
  HOST_STATE_SCHEMA_VERSION,
  HOST_STATE_SQLITE_SCHEMA_MANIFEST,
  type HostStateMigration,
  isExpectedHostStateMigrationDigest,
} from "./migrations.js";

const PINNED_VERSION_ONE_DIGEST = "Pk8Yrc3jVK9xoHKDcBdeyejFYUSbyjnp-SH0VMA_Hec";
const PINNED_VERSION_TWO_DIGEST = "yx23Bca9rSZttCEInDAEOrzLVhq-KWcZLE1i27tqNiY";

describe("A1 host-state migrations", () => {
  it("pins the application id, schema version, and exact migration digests", () => {
    expect(HOST_STATE_APPLICATION_ID).toBe(0x52434c57);
    expect(HOST_STATE_SCHEMA_VERSION).toBe(2);
    expect(HOST_STATE_MIGRATION_DIGESTS).toEqual([
      PINNED_VERSION_ONE_DIGEST,
      PINNED_VERSION_TWO_DIGEST,
    ]);
    expect(HOST_STATE_SCHEMA_MANIFEST).toEqual({
      applicationId: 0x52434c57,
      schemaVersion: 2,
      migrationDigest: PINNED_VERSION_TWO_DIGEST,
      sqliteSchema: HOST_STATE_SQLITE_SCHEMA_MANIFEST,
    });
    expect(expectedHostStateSqliteSchemaManifest(1)).toHaveLength(6);
    expect(expectedHostStateSqliteSchemaManifest(2)).toHaveLength(10);
  });

  it("commits every exact historical SQL byte into the chained digest", () => {
    const versionOne = HOST_STATE_MIGRATIONS[0];
    expect(versionOne).toBeDefined();
    if (versionOne === undefined) throw new Error("missing test migration");

    const editedVersionOne: HostStateMigration = {
      ...versionOne,
      statements: [`${versionOne.statements[0]} `, ...versionOne.statements.slice(1)],
    };
    expect(computeHostStateMigrationDigests([editedVersionOne])).not.toEqual(
      HOST_STATE_MIGRATION_DIGESTS,
    );

    const versionTwo: HostStateMigration = {
      version: 2,
      id: "002-test-successor",
      statements: ["CREATE TABLE test_successor (id INTEGER PRIMARY KEY) STRICT"],
    };
    const originalChain = computeHostStateMigrationDigests([versionOne, versionTwo]);
    const editedChain = computeHostStateMigrationDigests([editedVersionOne, versionTwo]);
    expect(originalChain[0]).toBe(PINNED_VERSION_ONE_DIGEST);
    expect(editedChain[0]).not.toBe(originalChain[0]);
    expect(editedChain[1]).not.toBe(originalChain[1]);
  });

  it("rejects gaps, reordering, duplicate ids, and invalid SQL", () => {
    const migration = HOST_STATE_MIGRATIONS[0];
    expect(migration).toBeDefined();
    if (migration === undefined) throw new Error("missing test migration");

    expect(() => assertHostStateMigrationRegistry([])).toThrow(/at least one migration/);
    expect(() => assertHostStateMigrationRegistry([{ ...migration, version: 2 }])).toThrow(
      /version 1 must be present/,
    );
    expect(() =>
      assertHostStateMigrationRegistry([migration, { ...migration, version: 2 }]),
    ).toThrow(/duplicated/);
    expect(() => assertHostStateMigrationRegistry([{ ...migration, statements: [] }])).toThrow(
      /at least one SQL statement/,
    );
    expect(() =>
      assertHostStateMigrationRegistry([{ ...migration, statements: ["SELECT 1\0"] }]),
    ).toThrow(/invalid SQL/);
  });

  it("validates only the canonical digest for a supported version", () => {
    expect(expectedHostStateMigrationDigest(1)).toBe(PINNED_VERSION_ONE_DIGEST);
    expect(expectedHostStateMigrationDigest(2)).toBe(PINNED_VERSION_TWO_DIGEST);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ONE_DIGEST, 1)).toBe(true);
    expect(isExpectedHostStateMigrationDigest(`${PINNED_VERSION_ONE_DIGEST}=`, 1)).toBe(false);
    expect(isExpectedHostStateMigrationDigest("A".repeat(43), 1)).toBe(false);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ONE_DIGEST, 2)).toBe(false);
    expect(() => expectedHostStateMigrationDigest(0)).toThrow(/not supported/);
    expect(() => expectedHostStateMigrationDigest(3)).toThrow(/not supported/);
  });

  it("creates exactly the declared application schema", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of HOST_STATE_MIGRATIONS) {
        for (const statement of migration.statements) database.exec(statement);
      }
      const rows = database
        .prepare(
          `SELECT type, name, tbl_name AS tableName, sql
           FROM sqlite_schema
           ORDER BY type, name`,
        )
        .all();
      const expected = [...HOST_STATE_SQLITE_SCHEMA_MANIFEST].sort((left, right) =>
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
      expect(rows).toEqual(expected);

      expect(
        database
          .prepare("PRAGMA table_info(protected_artifacts)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "protected_handle_id",
        "kind",
        "scope_kind",
        "scope_id",
        "artifact_schema_id",
        "artifact_digest",
        "byte_length",
        "artifact_bytes",
        "created_at_ms",
      ]);
    } finally {
      database.close();
    }
  });

  it("makes applied migration history append-only at the database boundary", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of HOST_STATE_MIGRATIONS) {
        for (const statement of migration.statements) database.exec(statement);
      }
      database
        .prepare(
          `INSERT INTO host_state_migrations
             (schema_version, migration_id, migration_digest, applied_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(1, "001-initial-host-state", PINNED_VERSION_ONE_DIGEST, 1);

      expect(() =>
        database
          .prepare("UPDATE host_state_migrations SET applied_at_ms = 2 WHERE schema_version = 1")
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        database.prepare("DELETE FROM host_state_migrations WHERE schema_version = 1").run(),
      ).toThrow(/append-only/);
      expect(() =>
        database
          .prepare(
            `INSERT OR REPLACE INTO host_state_migrations
               (schema_version, migration_id, migration_digest, applied_at_ms)
             VALUES (1, 'changed-id', ?, 2)`,
          )
          .run(PINNED_VERSION_ONE_DIGEST),
      ).toThrow(/append-only/);
    } finally {
      database.close();
    }
  });

  it("makes protected artifacts immutable at the database boundary", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of HOST_STATE_MIGRATIONS) {
        for (const statement of migration.statements) database.exec(statement);
      }
      expect(database.prepare("PRAGMA recursive_triggers").get()).toEqual({
        recursive_triggers: 0,
      });
      database
        .prepare(
          `INSERT INTO protected_artifacts
             (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
              artifact_digest, byte_length, artifact_bytes, created_at_ms)
           VALUES (?, 'artifact', 'host_profile', 'default', ?, ?, 1, ?, 1)`,
        )
        .run(
          "rcph_AAAAAAAAAAAAAAAAAAAAAA",
          "test/v1",
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          Uint8Array.of(1),
        );

      expect(() =>
        database.prepare("UPDATE protected_artifacts SET created_at_ms = 2").run(),
      ).toThrow(/immutable/);
      expect(() => database.prepare("DELETE FROM protected_artifacts").run()).toThrow(/immutable/);
      expect(() =>
        database
          .prepare(
            `INSERT OR REPLACE INTO protected_artifacts
               (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
                artifact_digest, byte_length, artifact_bytes, created_at_ms)
             VALUES (?, 'artifact', 'host_profile', 'default', ?, ?, 1, ?, 2)`,
          )
          .run(
            "rcph_AAAAAAAAAAAAAAAAAAAAAA",
            "test/v1",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            Uint8Array.of(2),
          ),
      ).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });
});
