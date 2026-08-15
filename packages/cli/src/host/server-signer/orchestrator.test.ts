import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseA1CanonicalId, parseA1SafeId } from "../state/ids.js";
import { resolveHostStatePaths } from "../state/path.js";
import type { HostStateTransaction } from "../state/sqlite.js";
import { HostStateCommitOutcomeUnknownError, openHostStateDatabase } from "../state/sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "../state/test-environment.js";
import {
  acquireUsableServerSigningLease,
  type DormantServerSignerDatabase,
  resumeInitialServerSigner,
} from "./orchestrator.js";
import { createServerKeyCustodySigner } from "./service.js";

const MACHINE_IDENTITY_ID = "b8".repeat(16);
const NOW_MS = 900_000;
const temporaryRoots: string[] = [];
const describeLinux = describe.runIf(
  process.platform === "linux" &&
    typeof process.getuid === "function" &&
    HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
);

function encoded(fill: number): string {
  return Buffer.from(new Uint8Array(16).fill(fill)).toString("base64url");
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-server-signer-recovery-"),
  );
  temporaryRoots.push(root);
  const environment = {
    xdgStateHome: join(root, "state"),
    homeDirectory: join(root, "home"),
  };
  return { environment, paths: resolveHostStatePaths(MACHINE_IDENTITY_ID, environment) };
}

function destroyInventoryEnvelopes(
  inventory: ReturnType<DormantServerSignerDatabase["serverSigning"]["readInventory"]>,
): void {
  for (const envelope of inventory.privateKeyEnvelopes) {
    envelope.wrapNonce.destroy();
    envelope.wrappedPkcs8.destroy();
    envelope.authTag.destroy();
  }
}

function unknownCommitDatabase(
  database: ReturnType<typeof openHostStateDatabase>,
  targetTransaction: number,
  outcome: "landed" | "absent",
): DormantServerSignerDatabase {
  let transactionCount = 0;
  return {
    machineIdentityId: database.machineIdentityId,
    serverSigning: database.serverSigning,
    transaction<T>(operation: (transaction: HostStateTransaction) => T): T {
      transactionCount += 1;
      if (transactionCount !== targetTransaction) return database.transaction(operation);
      if (outcome === "landed") {
        database.transaction(operation);
      } else {
        const rollbackMarker = Object.freeze({ rollbackMarker: true });
        try {
          database.transaction((transaction) => {
            operation(transaction);
            throw rollbackMarker;
          });
        } catch (error) {
          if (error !== rollbackMarker) throw error;
        }
      }
      throw new HostStateCommitOutcomeUnknownError(`simulated ${outcome} signer COMMIT outcome`);
    },
    close: () => database.close(),
  };
}

function crashAfterDatabase(
  database: ReturnType<typeof openHostStateDatabase>,
  targetTransaction: number,
): DormantServerSignerDatabase {
  let transactionCount = 0;
  return {
    machineIdentityId: database.machineIdentityId,
    serverSigning: database.serverSigning,
    transaction<T>(operation: (transaction: HostStateTransaction) => T): T {
      transactionCount += 1;
      const result = database.transaction(operation);
      if (transactionCount === targetTransaction) throw new Error("simulated process crash");
      return result;
    },
    close: () => database.close(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("dormant server-signer crash recovery", () => {
  it.each([
    ["prepare", "landed", 1],
    ["prepare", "absent", 1],
    ["bind", "landed", 2],
    ["bind", "absent", 2],
    ["store", "landed", 3],
    ["store", "absent", 3],
    ["finalize", "landed", 4],
    ["finalize", "absent", 4],
  ] as const)("reopens and reconciles a %s COMMIT proved %s", (_phase, outcome, targetTransaction) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const opened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const rootSecret = new Uint8Array(32).fill(31);
    const custody = createServerKeyCustodySigner(rootSecret);
    const sign = vi.fn(
      (
        envelope: Parameters<typeof custody.sign>[0],
        payload: Parameters<typeof custody.sign>[1],
      ) => {
        const contender = new DatabaseSync(opened.databasePath);
        let beginError: unknown;
        try {
          try {
            contender.exec("BEGIN IMMEDIATE");
          } catch (error) {
            beginError = error;
          }
          if (beginError === undefined) contender.exec("ROLLBACK");
        } finally {
          contender.close();
        }
        expect(String(beginError)).toMatch(/database is locked/i);
        return custody.sign(envelope, payload);
      },
    );
    const observedCustody = {
      generateIdentityKey: custody.generateIdentityKey.bind(custody),
      sign,
      assertUsable: custody.assertUsable.bind(custody),
    };
    let active: DormantServerSignerDatabase = opened;
    try {
      const server = opened.records.ensureDefaultCollaborationServer().server;
      const coordinator = opened.records.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${encoded(32)}`),
        ownerInstanceId: parseA1SafeId("server-signer-recovery-owner"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 600_000,
      });
      active = unknownCommitDatabase(opened, targetTransaction, outcome);
      const result = resumeInitialServerSigner({
        database: active,
        reopenDatabase: () =>
          openHostStateDatabase({
            machineIdentityId: MACHINE_IDENTITY_ID,
            pathEnvironment: state.environment,
          }),
        custody: observedCustody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        collaborationServerId: server.collaborationServerId,
        coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
        coordinatorEpoch: coordinator.lease.coordinatorEpoch,
        bootstrapSigningLeaseId: parseA1SafeId("recovered-bootstrap-lease"),
        signingLeaseId: parseA1SafeId("recovered-signing-lease"),
        signingKeyRef: parseA1CanonicalId("protectedHandle", `rcph_${encoded(33)}`),
        scopeCertificateId: parseA1SafeId("recovered-scope-certificate"),
        preparedAtMs: NOW_MS,
        issuedAtMs: NOW_MS,
        expectedServerSignatureSeq: 0,
        expectedFencingToken: 0,
      });
      active = result.database;
      expect(result).toMatchObject({
        signerWritable: true,
        nonWritableReason: null,
        reconciledUnknownCommitCount: 1,
        finalization: {
          bootstrapLease: { state: "closed" },
          signingLease: { state: "current", fencingToken: 2 },
          reservation: { state: "signed", signerSequence: 0 },
        },
      });
      expect(sign).toHaveBeenCalledTimes(1);
      const inventory = active.serverSigning.readInventory(server.collaborationServerId);
      try {
        expect(inventory.identityKeys).toHaveLength(1);
        expect(inventory.privateKeyEnvelopes).toHaveLength(1);
        expect(inventory.bootstrapLeases).toHaveLength(1);
        expect(inventory.reservations).toHaveLength(1);
        expect(inventory.scopeCertificates).toHaveLength(1);
        expect(inventory.signingLeases).toHaveLength(1);
        expect(inventory.acceptances).toHaveLength(1);
      } finally {
        destroyInventoryEnvelopes(inventory);
      }
    } finally {
      active.close();
      custody.close();
      rootSecret.fill(0);
    }
  });

  it.each([
    ["prepare", 1],
    ["bind", 2],
    ["store", 3],
    ["finalize", 4],
  ] as const)("resumes after a process crash following %s", (_phase, targetTransaction) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const opened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const rootSecret = new Uint8Array(32).fill(41);
    const custody = createServerKeyCustodySigner(rootSecret);
    let active: DormantServerSignerDatabase = opened;
    try {
      const server = opened.records.ensureDefaultCollaborationServer().server;
      const coordinator = opened.records.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${encoded(42)}`),
        ownerInstanceId: parseA1SafeId("server-signer-crash-owner"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 600_000,
      });
      const stableRequest = {
        custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        collaborationServerId: server.collaborationServerId,
        coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
        coordinatorEpoch: coordinator.lease.coordinatorEpoch,
        bootstrapSigningLeaseId: parseA1SafeId("crash-bootstrap-lease"),
        signingLeaseId: parseA1SafeId("crash-signing-lease"),
        signingKeyRef: parseA1CanonicalId("protectedHandle", `rcph_${encoded(43)}`),
        scopeCertificateId: parseA1SafeId("crash-scope-certificate"),
        preparedAtMs: NOW_MS,
        issuedAtMs: NOW_MS,
        expectedServerSignatureSeq: 0 as const,
        expectedFencingToken: 0 as const,
      };
      active = crashAfterDatabase(opened, targetTransaction);
      expect(() =>
        resumeInitialServerSigner({
          ...stableRequest,
          database: active,
          reopenDatabase: () => {
            throw new Error("a normal process crash must not use unknown-COMMIT recovery");
          },
        }),
      ).toThrow("simulated process crash");
      active.close();
      active = openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      });
      const resumed = resumeInitialServerSigner({
        ...stableRequest,
        database: active,
        reopenDatabase: () =>
          openHostStateDatabase({
            machineIdentityId: MACHINE_IDENTITY_ID,
            pathEnvironment: state.environment,
          }),
      });
      active = resumed.database;
      expect(resumed).toMatchObject({
        resumedDurableBootstrap: true,
        reconciledUnknownCommitCount: 0,
        signerWritable: true,
        finalization: {
          bootstrapLease: { state: "closed" },
          signingLease: { state: "current" },
        },
      });
    } finally {
      active.close();
      custody.close();
      rootSecret.fill(0);
    }
  });

  it.each([
    "landed",
    "absent",
  ] as const)("custody-qualifies a takeover lease after an acquisition COMMIT proved %s", (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    let database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const rootSecret = new Uint8Array(32).fill(51);
    const wrongRootSecret = new Uint8Array(32).fill(52);
    const custody = createServerKeyCustodySigner(rootSecret);
    const wrongCustody = createServerKeyCustodySigner(wrongRootSecret);
    let active: DormantServerSignerDatabase = database;
    try {
      const server = database.records.ensureDefaultCollaborationServer().server;
      const initialCoordinator = database.records.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${encoded(53)}`),
        ownerInstanceId: parseA1SafeId("server-signer-takeover-owner-1"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 600_000,
      });
      const installed = resumeInitialServerSigner({
        database,
        reopenDatabase: () =>
          openHostStateDatabase({
            machineIdentityId: MACHINE_IDENTITY_ID,
            pathEnvironment: state.environment,
          }),
        custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        collaborationServerId: server.collaborationServerId,
        coordinatorLeaseId: initialCoordinator.lease.coordinatorLeaseId,
        coordinatorEpoch: initialCoordinator.lease.coordinatorEpoch,
        bootstrapSigningLeaseId: parseA1SafeId("takeover-bootstrap-lease"),
        signingLeaseId: parseA1SafeId("takeover-signing-lease-1"),
        signingKeyRef: parseA1CanonicalId("protectedHandle", `rcph_${encoded(54)}`),
        scopeCertificateId: parseA1SafeId("takeover-scope-certificate"),
        preparedAtMs: NOW_MS,
        issuedAtMs: NOW_MS,
        expectedServerSignatureSeq: 0,
        expectedFencingToken: 0,
      });
      database = installed.database as typeof database;
      active = database;
      database.records.releaseCoordinatorLease({
        fence: {
          collaborationServerId: server.collaborationServerId,
          coordinatorLeaseId: initialCoordinator.lease.coordinatorLeaseId,
          coordinatorEpoch: initialCoordinator.lease.coordinatorEpoch,
        },
      });
      vi.setSystemTime(NOW_MS + 1);
      const successorCoordinator = database.records.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${encoded(55)}`),
        ownerInstanceId: parseA1SafeId("server-signer-takeover-owner-2"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: initialCoordinator.lease.coordinatorEpoch,
        leaseDurationMs: 600_000,
      });
      const acquisition = {
        fence: {
          collaborationServerId: server.collaborationServerId,
          coordinatorLeaseId: successorCoordinator.lease.coordinatorLeaseId,
          coordinatorEpoch: successorCoordinator.lease.coordinatorEpoch,
        },
        signingLeaseId: parseA1SafeId("takeover-signing-lease-2"),
        expectedCurrentSigningLeaseId: installed.finalization.signingLease.signingLeaseId,
        expectedFencingToken: installed.finalization.signingLease.fencingToken,
      };
      expect(() =>
        acquireUsableServerSigningLease({
          database,
          reopenDatabase: () => database,
          custody: wrongCustody,
          machineIdentityId: MACHINE_IDENTITY_ID,
          acquisition,
        }),
      ).toThrow(/unusable under the current custody root/);
      active = unknownCommitDatabase(database, 1, outcome);
      const acquired = acquireUsableServerSigningLease({
        database: active,
        reopenDatabase: () =>
          openHostStateDatabase({
            machineIdentityId: MACHINE_IDENTITY_ID,
            pathEnvironment: state.environment,
          }),
        custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        acquisition,
      });
      active = acquired.database;
      expect(acquired).toMatchObject({
        reconciledUnknownCommitCount: 1,
        acquisition: {
          replayed: outcome === "landed",
          predecessor: { state: "superseded", fencingToken: 2 },
          signingLease: { state: "current", fencingToken: 3 },
        },
      });
    } finally {
      active.close();
      custody.close();
      wrongCustody.close();
      rootSecret.fill(0);
      wrongRootSecret.fill(0);
    }
  });

  it("refuses a stale bound bootstrap before invoking the custody signer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    let database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    let active: DormantServerSignerDatabase = database;
    const rootSecret = new Uint8Array(32).fill(61);
    const custody = createServerKeyCustodySigner(rootSecret);
    const sign = vi.fn(custody.sign.bind(custody));
    const observedCustody = {
      generateIdentityKey: custody.generateIdentityKey.bind(custody),
      sign,
      assertUsable: custody.assertUsable.bind(custody),
    };
    try {
      const server = database.records.ensureDefaultCollaborationServer().server;
      const initialCoordinator = database.records.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${encoded(62)}`),
        ownerInstanceId: parseA1SafeId("server-signer-stale-owner-1"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 600_000,
      });
      const stableRequest = {
        custody: observedCustody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        collaborationServerId: server.collaborationServerId,
        coordinatorLeaseId: initialCoordinator.lease.coordinatorLeaseId,
        coordinatorEpoch: initialCoordinator.lease.coordinatorEpoch,
        bootstrapSigningLeaseId: parseA1SafeId("stale-bootstrap-lease"),
        signingLeaseId: parseA1SafeId("stale-signing-lease"),
        signingKeyRef: parseA1CanonicalId("protectedHandle", `rcph_${encoded(63)}`),
        scopeCertificateId: parseA1SafeId("stale-scope-certificate"),
        preparedAtMs: NOW_MS,
        issuedAtMs: NOW_MS,
        expectedServerSignatureSeq: 0 as const,
        expectedFencingToken: 0 as const,
      };
      const crashDatabase = crashAfterDatabase(database, 2);
      expect(() =>
        resumeInitialServerSigner({
          ...stableRequest,
          database: crashDatabase,
          reopenDatabase: () => {
            throw new Error("a normal process crash must not reopen during the failed call");
          },
        }),
      ).toThrow("simulated process crash");
      crashDatabase.close();
      database = openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      });
      active = database;
      database.records.releaseCoordinatorLease({
        fence: {
          collaborationServerId: server.collaborationServerId,
          coordinatorLeaseId: initialCoordinator.lease.coordinatorLeaseId,
          coordinatorEpoch: initialCoordinator.lease.coordinatorEpoch,
        },
      });
      vi.setSystemTime(NOW_MS + 1);
      database.records.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${encoded(64)}`),
        ownerInstanceId: parseA1SafeId("server-signer-stale-owner-2"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: initialCoordinator.lease.coordinatorEpoch,
        leaseDurationMs: 600_000,
      });
      expect(() =>
        resumeInitialServerSigner({
          ...stableRequest,
          database: active,
          reopenDatabase: () =>
            openHostStateDatabase({
              machineIdentityId: MACHINE_IDENTITY_ID,
              pathEnvironment: state.environment,
            }),
        }),
      ).toThrow(/stale_bootstrap_fence/);
      expect(sign).not.toHaveBeenCalled();
    } finally {
      active.close();
      custody.close();
      rootSecret.fill(0);
    }
  });
});
