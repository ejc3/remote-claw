import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { parseA1Digest, parseA1SafeId } from "./ids.js";
import { expectedHostStateSqliteSchemaManifest, HOST_STATE_SCHEMA_VERSION } from "./migrations.js";
import { resolveHostStatePaths } from "./path.js";
import type { AcquireRuntimeOwnerServiceLeaseRequest } from "./runtime-repository.js";
import {
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  type HostStateTransaction,
  openHostStateDatabase,
  RuntimeOwnerRepositoryPersistenceError,
} from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "84".repeat(16);
const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];

function digest(fill: number) {
  return parseA1Digest(base64urlEncode(new Uint8Array(32).fill(fill)));
}

function acquisitionRequest(fill: number): AcquireRuntimeOwnerServiceLeaseRequest {
  return {
    candidateLeaseId: parseA1SafeId(`runtime-owner-lease-${fill}`),
    ownerInstanceId: parseA1SafeId(`runtime-owner-instance-${fill}`),
    ownerProcessStartIdentitySchemaId: "remote-claw/sqlite-runtime-owner-process/v1",
    ownerProcessStartIdentityRef: parseA1SafeId(`runtime-owner-process-${fill}`),
    ownerProcessStartIdentityDigest: digest(fill),
    expectedCurrentLeaseId: null,
    expectedRuntimeOwnerServiceEpoch: 0,
    leaseDurationMs: 600_000,
    operation: {
      operationId: parseA1SafeId(`runtime-owner-acquire-operation-${fill}`),
      operationSchemaId: "remote-claw/sqlite-runtime-owner-acquire/v1",
      operationDigest: digest(fill + 1),
    },
  };
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a13-sqlite-runtime-owner-"),
  );
  temporaryRoots.push(root);
  const environment = {
    xdgStateHome: join(root, "state"),
    homeDirectory: join(root, "home"),
  };
  return {
    environment,
    paths: resolveHostStatePaths(MACHINE_IDENTITY_ID, environment),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.3 secure runtime-owner SQLite integration", () => {
  it("keeps SQLite and arbitrary SQL out of both high-level surfaces", () => {
    expectTypeOf<keyof HostStateDatabase>().toEqualTypeOf<
      | "machineIdentityId"
      | "databasePath"
      | "schemaVersion"
      | "records"
      | "runtimeOwner"
      | "registration"
      | "putArtifact"
      | "readVerifiedArtifact"
      | "transaction"
      | "close"
    >();
    expectTypeOf<keyof HostStateTransaction>().toEqualTypeOf<
      "records" | "runtimeOwner" | "registration" | "putArtifact" | "readVerifiedArtifact"
    >();
  });

  it("atomically composes record and runtime-owner writes, then reopens the durable inventory", () => {
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const request = acquisitionRequest(11);

    expect(() =>
      database.transaction((transaction) => {
        transaction.records.ensureDefaultCollaborationServer();
        transaction.runtimeOwner.acquireServiceLease(request);
        throw new Error("abort the composed transaction");
      }),
    ).toThrow("abort the composed transaction");
    expect(database.records.readDefaultCollaborationServer()).toBeNull();
    expect(database.runtimeOwner.readInventory()).toMatchObject({
      state: {
        currentRuntimeOwnerServiceEpoch: 0,
        currentRuntimeOwnerServiceLeaseId: null,
        nextJournalOffset: 0,
      },
      serviceLeases: [],
      journal: [],
    });

    const acquired = database.runtimeOwner.acquireServiceLease(request);
    const inventory = database.runtimeOwner.readInventory();
    expect(inventory).toMatchObject({
      state: {
        currentRuntimeOwnerServiceEpoch: 1,
        currentRuntimeOwnerServiceLeaseId: request.candidateLeaseId,
        nextJournalOffset: 1,
      },
      serviceLeases: [acquired.lease],
      journal: [acquired.journalEntry],
    });
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      expect(reopened.runtimeOwner.readInventory()).toEqual(inventory);
      expect(reopened.runtimeOwner.reconcileServiceLeaseAcquisition(request)).toEqual({
        ...acquired,
        replayed: true,
      });
    } finally {
      reopened.close();
    }
  });

  it("poisons a handle after a runtime-owner persistence failure", () => {
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const originalPrepare = DatabaseSync.prototype.prepare;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (armed && sql.includes("FROM runtime_owner_state")) {
        throw new Error("simulated runtime-owner read failure");
      }
      return Reflect.apply(originalPrepare, this, [sql]);
    });

    expect(() => database.runtimeOwner.readInventory()).toThrow(
      RuntimeOwnerRepositoryPersistenceError,
    );
    armed = false;
    expect(() => database.runtimeOwner.readInventory()).toThrow(/poisoned/);
    database.close();
  });

  it("reopens and reconciles an acquisition whose COMMIT landed before an unknown outcome", () => {
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const request = acquisitionRequest(21);
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      Reflect.apply(originalExec, this, [sql]);
      if (armed && sql === "COMMIT") {
        throw new Error("simulated lost COMMIT acknowledgement");
      }
    });

    expect(() => database.runtimeOwner.acquireServiceLease(request)).toThrow(
      HostStateCommitOutcomeUnknownError,
    );
    armed = false;
    expect(() => database.runtimeOwner.readInventory()).toThrow(/poisoned/);
    database.close();
    vi.restoreAllMocks();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      const reconciled = reopened.runtimeOwner.reconcileServiceLeaseAcquisition(request);
      expect(reconciled).toMatchObject({
        replayed: true,
        isCurrent: true,
        lease: {
          runtimeOwnerServiceLeaseId: request.candidateLeaseId,
          runtimeOwnerServiceEpoch: 1,
          state: "current",
        },
      });
      expect(reopened.runtimeOwner.readInventory()).toMatchObject({
        state: { currentRuntimeOwnerServiceLeaseId: request.candidateLeaseId },
        serviceLeases: [{ runtimeOwnerServiceLeaseId: request.candidateLeaseId }],
        journal: [{ operationId: request.operation.operationId }],
      });
    } finally {
      reopened.close();
    }
  });

  it("rejects a trigger-valid schema whose runtime-owner graph is semantically corrupt", () => {
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    database.runtimeOwner.acquireServiceLease(acquisitionRequest(31));
    database.close();

    const trigger = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION).find(
      (entry) => entry.name === "runtime_owner_state_lease_transition",
    );
    if (trigger === undefined) throw new Error("missing runtime-owner state transition trigger");
    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      editor.exec("DROP TRIGGER runtime_owner_state_lease_transition");
      editor.exec(
        "UPDATE runtime_owner_state SET current_runtime_owner_service_lease_id = NULL WHERE singleton = 1",
      );
      editor.exec(trigger.sql);
    } finally {
      editor.close();
    }

    expect(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      }),
    ).toThrow(/runtime-owner records failed semantic validation/);
  });
});
