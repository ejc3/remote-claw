import { createHash } from "node:crypto";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactSqlTransaction,
  type ArtifactSqlValue,
  type ArtifactTransactionExecutor,
  createProtectedArtifactTransactionOperations,
  MAX_PROTECTED_ARTIFACT_BYTES,
  MAX_PROTECTED_ARTIFACT_ID_ATTEMPTS,
  MAX_PROTECTED_ARTIFACT_SCHEMA_ID_UTF8_BYTES,
  ProtectedArtifactPersistenceError,
  ProtectedArtifactRepository,
} from "./artifacts.js";
import { type A1Digest, parseA1CanonicalId, parseA1Digest } from "./ids.js";
import {
  ProtectedByteSnapshot,
  type PutArtifactRequest,
  type ReadVerifiedArtifactRequest,
} from "./protected.js";

type ArtifactRow = {
  protected_handle_id: string;
  kind: string;
  scope_kind: string;
  scope_id: string;
  artifact_schema_id: string;
  artifact_digest: string;
  byte_length: number;
  artifact_bytes: Uint8Array;
  created_at_ms: number;
};

function cloneRow(row: ArtifactRow): ArtifactRow {
  return { ...row, artifact_bytes: Uint8Array.from(row.artifact_bytes) };
}

class FakeArtifactDatabase implements ArtifactTransactionExecutor, ArtifactSqlTransaction {
  readonly rows = new Map<string, ArtifactRow>();
  transactions = 0;

  transaction<T>(operation: (transaction: ArtifactSqlTransaction) => T): T {
    this.transactions++;
    return operation(this);
  }

  get(sql: string, parameters: readonly ArtifactSqlValue[]): unknown {
    const protectedHandleId = parameters[0];
    if (typeof protectedHandleId !== "string") throw new Error("expected protected handle ID");
    const row = this.rows.get(protectedHandleId);
    if (sql.includes("artifact_schema_id")) {
      return row === undefined ? undefined : cloneRow(row);
    }
    if (!sql.includes("SELECT protected_handle_id FROM protected_artifacts")) {
      throw new Error(`unexpected SQL: ${sql}`);
    }
    return row === undefined ? undefined : { protected_handle_id: protectedHandleId };
  }

  run(sql: string, parameters: readonly ArtifactSqlValue[]) {
    if (!sql.startsWith("INSERT INTO protected_artifacts") || parameters.length !== 9) {
      throw new Error(`unexpected SQL: ${sql}`);
    }
    const [
      protectedHandleId,
      kind,
      scopeKind,
      scopeId,
      artifactSchemaId,
      artifactDigest,
      byteLength,
      artifactBytes,
      createdAtMs,
    ] = parameters;
    if (
      typeof protectedHandleId !== "string" ||
      typeof kind !== "string" ||
      typeof scopeKind !== "string" ||
      typeof scopeId !== "string" ||
      typeof artifactSchemaId !== "string" ||
      typeof artifactDigest !== "string" ||
      typeof byteLength !== "number" ||
      !(artifactBytes instanceof Uint8Array) ||
      typeof createdAtMs !== "number"
    ) {
      throw new Error("unexpected artifact insert values");
    }
    if (this.rows.has(protectedHandleId)) throw new Error("duplicate protected handle ID");
    this.rows.set(protectedHandleId, {
      protected_handle_id: protectedHandleId,
      kind,
      scope_kind: scopeKind,
      scope_id: scopeId,
      artifact_schema_id: artifactSchemaId,
      artifact_digest: artifactDigest,
      byte_length: byteLength,
      artifact_bytes: Uint8Array.from(artifactBytes),
      created_at_ms: createdAtMs,
    });
    return { changes: 1 };
  }

  seedCollision(protectedHandleId: string): void {
    this.rows.set(protectedHandleId, {
      protected_handle_id: protectedHandleId,
      kind: "artifact",
      scope_kind: "host_profile",
      scope_id: "default",
      artifact_schema_id: "collision/v1",
      artifact_digest: digest(Uint8Array.of()),
      byte_length: 0,
      artifact_bytes: Uint8Array.of(),
      created_at_ms: 0,
    });
  }
}

function digest(bytes: Uint8Array): A1Digest {
  return parseA1Digest(createHash("sha256").update(bytes).digest("base64url"));
}

function entropy(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

function protectedHandleId(fill: number) {
  return parseA1CanonicalId("protectedHandle", `rcph_${base64urlEncode(entropy(fill))}`);
}

function collaborationServerId(fill: number) {
  return parseA1CanonicalId("collaborationServer", `rcs_${base64urlEncode(entropy(fill))}`);
}

function putRequest(
  bytes: Uint8Array,
  overrides: Partial<PutArtifactRequest> = {},
): PutArtifactRequest {
  return {
    scopeKind: "host_profile",
    scopeId: "default",
    artifactSchemaId: "remote-claw/test-artifact/v1",
    artifactDigest: digest(bytes),
    artifactBytes: ProtectedByteSnapshot.from(bytes),
    ...overrides,
  } as PutArtifactRequest;
}

function readRequest(
  put: Awaited<ReturnType<ProtectedArtifactRepository["putArtifact"]>>,
  overrides: Partial<ReadVerifiedArtifactRequest> = {},
): ReadVerifiedArtifactRequest {
  return {
    scopeKind: put.scopeKind,
    scopeId: put.scopeId,
    artifactRef: put.artifactRef,
    artifactSchemaId: put.artifactSchemaId,
    expectedArtifactDigest: put.artifactDigest,
    ...overrides,
  } as ReadVerifiedArtifactRequest;
}

function sequentialRandom(...values: Uint8Array[]): (byteLength: number) => Uint8Array {
  let index = 0;
  return (byteLength) => {
    expect(byteLength).toBe(16);
    const value = values[index++];
    if (value === undefined) throw new Error("random sequence exhausted");
    return Uint8Array.from(value);
  };
}

const UNVERIFIED_MESSAGE = "host state contract rejected: protected artifact could not be verified";
const UNVERIFIED = `HostStateContractError: ${UNVERIFIED_MESSAGE}`;

describe("protected artifact repository", () => {
  it("stores the selected row fields and snapshots bytes on both sides", async () => {
    const database = new FakeArtifactDatabase();
    const source = Uint8Array.of(1, 2, 3, 4);
    const request = putRequest(source);
    source.fill(0xff);
    const repository = new ProtectedArtifactRepository(database, {
      randomBytes: () => entropy(1),
      nowMs: () => 1234,
    });

    const put = await repository.putArtifact(request);
    expect(Object.isFrozen(put)).toBe(true);
    expect(put).toMatchObject({
      scopeKind: "host_profile",
      scopeId: "default",
      artifactSchemaId: "remote-claw/test-artifact/v1",
      artifactDigest: digest(Uint8Array.of(1, 2, 3, 4)),
      byteLength: 4,
      artifactRef: { protectedHandleId: protectedHandleId(1), kind: "artifact" },
    });
    expect(database.rows.get(put.artifactRef.protectedHandleId)).toEqual({
      protected_handle_id: put.artifactRef.protectedHandleId,
      kind: "artifact",
      scope_kind: "host_profile",
      scope_id: "default",
      artifact_schema_id: put.artifactSchemaId,
      artifact_digest: put.artifactDigest,
      byte_length: 4,
      artifact_bytes: Uint8Array.of(1, 2, 3, 4),
      created_at_ms: 1234,
    });

    const firstRead = await repository.readVerifiedArtifact(readRequest(put));
    const firstCopy = firstRead.artifactBytes.copyBytes();
    firstCopy.fill(0);
    const secondRead = await repository.readVerifiedArtifact(readRequest(put));
    expect(Object.isFrozen(firstRead)).toBe(true);
    expect(secondRead.artifactBytes).not.toBe(firstRead.artifactBytes);
    expect(secondRead.artifactBytes.copyBytes()).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(database.transactions).toBe(3);
  });

  it("exposes synchronous high-level operations bound to an existing transaction", () => {
    const database = new FakeArtifactDatabase();
    const operations = createProtectedArtifactTransactionOperations(database, {
      randomBytes: () => entropy(2),
      nowMs: () => 22,
    });
    const put = operations.putArtifact(putRequest(Uint8Array.of(9)));
    const read = operations.readVerifiedArtifact(readRequest(put));

    expect(read.artifactBytes.copyBytes()).toEqual(Uint8Array.of(9));
    expect(database.transactions).toBe(0);
  });

  it("rejects malformed puts, digest mismatches, and bounded fields before insertion", async () => {
    const database = new FakeArtifactDatabase();
    const repository = new ProtectedArtifactRepository(database, {
      randomBytes: () => entropy(3),
      nowMs: () => 0,
    });

    await expect(
      repository.putArtifact(
        putRequest(Uint8Array.of(1), { artifactDigest: digest(Uint8Array.of(2)) }),
      ),
    ).rejects.toThrow(/artifactDigest must match artifactBytes/);
    await expect(
      repository.putArtifact(putRequest(Uint8Array.of(1), { artifactSchemaId: "" })),
    ).rejects.toThrow(/must be a non-empty string/);
    await expect(
      repository.putArtifact(
        putRequest(Uint8Array.of(1), {
          artifactSchemaId: "é".repeat(
            Math.floor(MAX_PROTECTED_ARTIFACT_SCHEMA_ID_UTF8_BYTES / 2) + 1,
          ),
        }),
      ),
    ).rejects.toThrow(/UTF-8 bytes/);
    const oversized = new Uint8Array(MAX_PROTECTED_ARTIFACT_BYTES + 1);
    await expect(repository.putArtifact(putRequest(oversized))).rejects.toThrow(
      /must be at most 16777216 bytes/,
    );
    await expect(
      repository.putArtifact({
        ...putRequest(Uint8Array.of(1)),
        extra: true,
      } as unknown as PutArtifactRequest),
    ).rejects.toThrow(/exactly the selected fields/);
    expect(database.rows.size).toBe(0);
  });

  it("retries canonical random IDs on collision and has a hard retry bound", async () => {
    const database = new FakeArtifactDatabase();
    database.seedCollision(protectedHandleId(4));
    const randomBytes = vi.fn(sequentialRandom(entropy(4), entropy(5)));
    const repository = new ProtectedArtifactRepository(database, { randomBytes, nowMs: () => 1 });

    const put = await repository.putArtifact(putRequest(Uint8Array.of(7)));
    expect(put.artifactRef.protectedHandleId).toBe(protectedHandleId(5));
    expect(randomBytes).toHaveBeenCalledTimes(2);

    const exhaustedDatabase = new FakeArtifactDatabase();
    exhaustedDatabase.seedCollision(protectedHandleId(6));
    const exhaustedRandom = vi.fn(() => entropy(6));
    const exhausted = new ProtectedArtifactRepository(exhaustedDatabase, {
      randomBytes: exhaustedRandom,
      nowMs: () => 1,
    });
    await expect(exhausted.putArtifact(putRequest(Uint8Array.of(8)))).rejects.toThrow(
      new RegExp(`${MAX_PROTECTED_ARTIFACT_ID_ATTEMPTS} attempts`),
    );
    expect(exhaustedRandom).toHaveBeenCalledTimes(MAX_PROTECTED_ARTIFACT_ID_ATTEMPTS);
    expect(exhaustedDatabase.rows.size).toBe(1);
  });

  it("uses one non-oracular error for missing or mismatched read claims", async () => {
    const database = new FakeArtifactDatabase();
    const repository = new ProtectedArtifactRepository(database, {
      randomBytes: () => entropy(7),
      nowMs: () => 1,
    });
    const put = await repository.putArtifact(putRequest(Uint8Array.of(1, 2)));
    const otherRef = {
      protectedHandleId: protectedHandleId(8),
      kind: "artifact" as const,
    };
    const signingRef = {
      protectedHandleId: put.artifactRef.protectedHandleId,
      kind: "signing_key" as const,
    };
    const cases = [
      readRequest(put, { artifactRef: otherRef }),
      readRequest(put, { artifactRef: signingRef as never }),
      readRequest(put, { scopeId: "wrong" as never }),
      {
        ...readRequest(put),
        scopeKind: "collaboration_server",
        scopeId: collaborationServerId(12),
      } as ReadVerifiedArtifactRequest,
      readRequest(put, { artifactSchemaId: "wrong/v1" }),
      readRequest(put, { expectedArtifactDigest: digest(Uint8Array.of(2, 1)) }),
      { ...readRequest(put), extra: true } as unknown as ReadVerifiedArtifactRequest,
    ];

    for (const request of cases) {
      let error: unknown;
      try {
        await repository.readVerifiedArtifact(request);
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toBe(UNVERIFIED);
    }
  });

  it("uniformly rejects every stored identity, length, and byte-integrity corruption", async () => {
    const database = new FakeArtifactDatabase();
    const repository = new ProtectedArtifactRepository(database, {
      randomBytes: () => entropy(9),
      nowMs: () => 9,
    });
    const put = await repository.putArtifact(putRequest(Uint8Array.of(3, 4, 5)));
    const id = put.artifactRef.protectedHandleId;
    const original = cloneRow(database.rows.get(id) as ArtifactRow);
    const corruptions: Array<Partial<ArtifactRow>> = [
      { protected_handle_id: protectedHandleId(10) },
      { kind: "signing_key" },
      { scope_kind: "runtime" },
      { scope_id: "wrong" },
      { artifact_schema_id: "other/v1" },
      { artifact_digest: digest(Uint8Array.of(5, 4, 3)) },
      { byte_length: 2 },
      { artifact_bytes: Uint8Array.of(3, 4, 6) },
      { created_at_ms: -1 },
    ];

    for (const corruption of corruptions) {
      database.rows.set(id, { ...cloneRow(original), ...corruption });
      await expect(repository.readVerifiedArtifact(readRequest(put))).rejects.toThrow(
        UNVERIFIED_MESSAGE,
      );
    }
  });

  it("preserves storage failures instead of misreporting them as an unverified artifact", async () => {
    const database = new FakeArtifactDatabase();
    const repository = new ProtectedArtifactRepository(database, {
      randomBytes: () => entropy(12),
      nowMs: () => 1,
    });
    const put = await repository.putArtifact(putRequest(Uint8Array.of(1)));
    vi.spyOn(database, "get").mockImplementation(() => {
      throw new Error("simulated storage failure");
    });

    await expect(repository.readVerifiedArtifact(readRequest(put))).rejects.toBeInstanceOf(
      ProtectedArtifactPersistenceError,
    );
  });

  it("preserves lookup and insert failures as persistence errors", async () => {
    const lookupDatabase = new FakeArtifactDatabase();
    vi.spyOn(lookupDatabase, "get").mockImplementation(() => {
      throw new Error("simulated lookup failure");
    });
    const lookupRepository = new ProtectedArtifactRepository(lookupDatabase, {
      randomBytes: () => entropy(13),
      nowMs: () => 1,
    });
    await expect(lookupRepository.putArtifact(putRequest(Uint8Array.of(1)))).rejects.toBeInstanceOf(
      ProtectedArtifactPersistenceError,
    );

    const insertDatabase = new FakeArtifactDatabase();
    vi.spyOn(insertDatabase, "run").mockImplementation(() => {
      throw new Error("simulated insert failure");
    });
    const insertRepository = new ProtectedArtifactRepository(insertDatabase, {
      randomBytes: () => entropy(14),
      nowMs: () => 1,
    });
    await expect(insertRepository.putArtifact(putRequest(Uint8Array.of(1)))).rejects.toBeInstanceOf(
      ProtectedArtifactPersistenceError,
    );
  });

  it("rejects broken entropy sources and invalid clocks without inserting", async () => {
    const database = new FakeArtifactDatabase();
    const badEntropy = new ProtectedArtifactRepository(database, {
      randomBytes: () => new Uint8Array(15),
      nowMs: () => 0,
    });
    await expect(badEntropy.putArtifact(putRequest(Uint8Array.of()))).rejects.toThrow(
      /must return exactly 16 bytes/,
    );

    const badClock = new ProtectedArtifactRepository(database, {
      randomBytes: () => entropy(11),
      nowMs: () => -1,
    });
    await expect(badClock.putArtifact(putRequest(Uint8Array.of()))).rejects.toThrow(
      /createdAtMs must be a non-negative safe integer/,
    );
    expect(database.rows.size).toBe(0);
  });
});
