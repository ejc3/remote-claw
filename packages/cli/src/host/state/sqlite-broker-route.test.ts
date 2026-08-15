import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type A1BrokerEnsureRouteReceiptV1,
  type A1BrokerRoute,
  base64urlEncode,
} from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type A1BrokerNegotiatedClient,
  A1BrokerOutcomeUnknownError,
  type A1BrokerRouteHandle,
} from "../../broker/a1-client.js";
import {
  BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
  canonicalBrokerBackendCapabilitiesV1,
  REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
} from "./backend.js";
import {
  deriveBrokerRouteId,
  deriveBrokerRouteToken,
  type InstallBrokerRouteRequest,
  parseBrokerRouteStoreInstanceId,
  syncBrokerBackendCapabilitiesDigestV1,
} from "./broker-route.js";
import {
  DormantBrokerRouteCommitAbsentError,
  type DormantBrokerRouteDatabase,
  openAndInstallDormantBrokerRoute,
} from "./broker-route-orchestrator.js";
import {
  type A1CanonicalId,
  type A1CanonicalIdKind,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "./ids.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import * as sqliteExports from "./sqlite.js";
import {
  HostStateCommitOutcomeUnknownError,
  type HostStateTransaction,
  openHostStateDatabase,
  type TerminalRegistrationInput,
} from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "84".repeat(16);
const NOW_MS = 20_000;
const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];

function canonicalId<K extends A1CanonicalIdKind>(kind: K, fill: number): A1CanonicalId<K> {
  const prefixes = {
    collaborationServer: "rcs_",
    project: "rcpj_",
    logicalChat: "rcl_",
    inwardEdge: "rcie_",
    nativeBinding: "rcnb_",
    nativeRuntime: "rcrt_",
    coordinatorLease: "rccl_",
    registrationAttempt: "rcra_",
    nativeConversationLease: "rcncl_",
    protectedHandle: "rcph_",
    projectTargetSelectorMapping: "ptm_",
    nativeDeliveryAttempt: "nat_",
    collaborationCommand: "rcm_",
    collaborationCommandResult: "ccr_",
    commandSigningGroup: "csg_",
    commandResultPreparation: "crp_",
  } as const;
  const bytes =
    kind === "nativeRuntime" ||
    kind === "projectTargetSelectorMapping" ||
    kind === "nativeDeliveryAttempt" ||
    kind === "collaborationCommand" ||
    kind === "collaborationCommandResult" ||
    kind === "commandSigningGroup" ||
    kind === "commandResultPreparation"
      ? 32
      : 16;
  return parseA1CanonicalId(
    kind,
    `${prefixes[kind]}${base64urlEncode(new Uint8Array(bytes).fill(fill))}`,
  );
}

function digest(fill: number) {
  return parseA1Digest(base64urlEncode(new Uint8Array(32).fill(fill)));
}

function registration(fill: number): TerminalRegistrationInput {
  return {
    registrationAttemptId: canonicalId("registrationAttempt", fill),
    descriptor: { product: "codex", access: "app-server" },
    descriptorRef: parseA1SafeId(`descriptor-${fill}`),
    descriptorDigest: digest(fill + 1),
    projectRef: parseA1SafeId(`project-${fill}`),
    projectDigest: digest(fill + 2),
    expectedNativeRefDigest: null,
    initialPhase: "starting",
    metadataSchemaId: "remote-claw/sqlite-broker-route-test/v1",
    metadataRef: parseA1SafeId(`metadata-${fill}`),
    metadataDigest: digest(fill + 3),
    capabilitiesRef: null,
    capabilitiesDigest: null,
  };
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a16-sqlite-broker-route-"),
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

function routeRequest(
  serverId: A1CanonicalId<"collaborationServer">,
  chatId: A1CanonicalId<"logicalChat">,
  coordinatorLeaseId: A1CanonicalId<"coordinatorLease">,
  artifactRef: A1CanonicalId<"protectedHandle">,
): InstallBrokerRouteRequest {
  const brokerRouteId = deriveBrokerRouteId(MACHINE_IDENTITY_ID, serverId, "chat", chatId);
  const routeToken = deriveBrokerRouteToken(MACHINE_IDENTITY_ID, serverId, "chat", chatId);
  const capabilityDigest = syncBrokerBackendCapabilitiesDigestV1(
    REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
  );
  const generation = {
    schemaVersion: 1 as const,
    brokerRouteId,
    channelGeneration: 0 as const,
    state: "open" as const,
    frameCount: null,
    nextGeneration: null,
    manifestDigest: null,
  };
  return {
    fence: { collaborationServerId: serverId, coordinatorLeaseId, coordinatorEpoch: 1 },
    routeKind: "chat",
    logicalChatId: chatId,
    brokerOrigin: "https://broker.example",
    brokerBackendSelector: "sqlite",
    capabilityArtifactRef: { protectedHandleId: artifactRef, kind: "artifact" },
    capabilityObservedAtMs: NOW_MS,
    routeOpenedAtMs: NOW_MS,
    receipt: {
      schemaVersion: 1,
      disposition: "created",
      route: {
        schemaVersion: 1,
        brokerOrigin: "https://broker.example",
        backendSelector: "sqlite",
        routeStoreInstanceId: parseBrokerRouteStoreInstanceId(
          `rbsi_${base64urlEncode(new Uint8Array(16).fill(91))}`,
        ),
        identityId: MACHINE_IDENTITY_ID,
        collaborationServerId: serverId,
        routeKind: "chat",
        logicalChatId: chatId,
        brokerRouteId,
        routeToken,
        brokerBackendCapabilitiesDigest: capabilityDigest,
      },
      genesis: generation,
      currentGeneration: generation,
      observedNextFrameIndex: 0,
    },
  };
}

function establishChat(database: ReturnType<typeof openHostStateDatabase>) {
  const server = database.records.ensureDefaultCollaborationServer().server;
  const acquisition = database.records.acquireCoordinatorLease({
    collaborationServerId: server.collaborationServerId,
    candidateLeaseId: canonicalId("coordinatorLease", 41),
    ownerInstanceId: parseA1SafeId("a16-broker-route-owner"),
    expectedCurrentLeaseId: null,
    expectedCoordinatorEpoch: 0,
    leaseDurationMs: 600_000,
  });
  const fence = {
    collaborationServerId: server.collaborationServerId,
    coordinatorLeaseId: acquisition.lease.coordinatorLeaseId,
    coordinatorEpoch: acquisition.lease.coordinatorEpoch,
  };
  const chat = database.records.reserveFirstTerminalChat({
    fence,
    workspaceSelectorId: parseA1SafeId("a16-workspace"),
    terminalTarget: {
      kind: "terminal_native",
      descriptor: { product: "codex", access: "app-server" },
      terminalProjectRef: parseA1SafeId("a16-terminal-project"),
      nativeWorkspaceBindingId: null,
    },
    mappingEvidenceRef: parseA1SafeId("a16-mapping-evidence"),
    registration: registration(51),
  }).chat;
  return { server, acquisition, chat };
}

interface FakeRemoteOptions {
  readonly storeFill: number;
  readonly unknownFirst?: boolean;
  readonly disposition?: "created" | "existing";
  readonly mutateReceipt?: (receipt: A1BrokerEnsureRouteReceiptV1) => unknown;
}

function fakeNegotiatedClient(options: FakeRemoteOptions): Readonly<{
  client: A1BrokerNegotiatedClient;
  openRoute: ReturnType<typeof vi.fn>;
}> {
  const capabilityDigest = syncBrokerBackendCapabilitiesDigestV1(
    REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
  );
  const openRoute = vi.fn(async (route: A1BrokerRoute): Promise<A1BrokerRouteHandle> => {
    if (options.unknownFirst === true && openRoute.mock.calls.length === 1) {
      throw new A1BrokerOutcomeUnknownError();
    }
    const identityId = Buffer.from(route.identityId).toString("hex");
    const collaborationServerId = parseA1CanonicalId(
      "collaborationServer",
      route.collaborationServerId,
    );
    const logicalChatId =
      route.routeKind === "chat" ? parseA1CanonicalId("logicalChat", route.logicalChatId) : null;
    const brokerRouteId = deriveBrokerRouteId(
      identityId,
      collaborationServerId,
      route.routeKind,
      logicalChatId,
    );
    const routeToken = deriveBrokerRouteToken(
      identityId,
      collaborationServerId,
      route.routeKind,
      logicalChatId,
    );
    const routeStoreInstanceId = parseBrokerRouteStoreInstanceId(
      `rbsi_${base64urlEncode(new Uint8Array(16).fill(options.storeFill))}`,
    );
    const descriptor = {
      schemaVersion: 1 as const,
      brokerOrigin: "https://broker.example",
      backendSelector: "sqlite" as const,
      routeStoreInstanceId,
      identityId,
      collaborationServerId,
      routeKind: route.routeKind,
      logicalChatId,
      brokerRouteId,
      routeToken,
      brokerBackendCapabilitiesDigest: capabilityDigest,
    };
    const generation = {
      schemaVersion: 1 as const,
      brokerRouteId,
      channelGeneration: 0,
      state: "open" as const,
      frameCount: null,
      nextGeneration: null,
      manifestDigest: null,
    };
    const receipt: A1BrokerEnsureRouteReceiptV1 = {
      schemaVersion: 1,
      disposition: options.disposition ?? (options.unknownFirst === true ? "existing" : "created"),
      route: descriptor,
      genesis: generation,
      currentGeneration: generation,
      observedNextFrameIndex: 0,
    };
    return {
      descriptor,
      openReceipt: (options.mutateReceipt?.(receipt) ?? receipt) as A1BrokerEnsureRouteReceiptV1,
      publish: vi.fn(),
      read: vi.fn(),
    } as unknown as A1BrokerRouteHandle;
  });
  return {
    client: {
      brokerOrigin: "https://broker.example",
      brokerBackendCapabilitiesDigest: capabilityDigest,
      openRoute,
    },
    openRoute,
  };
}

function unknownCommitDatabase(
  database: ReturnType<typeof openHostStateDatabase>,
  outcome: "landed" | "absent",
): DormantBrokerRouteDatabase {
  let injected = false;
  return {
    machineIdentityId: database.machineIdentityId,
    brokerRoute: database.brokerRoute,
    transaction<T>(operation: (transaction: HostStateTransaction) => T): T {
      if (injected) return database.transaction(operation);
      injected = true;
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
      throw new HostStateCommitOutcomeUnknownError(`simulated ${outcome} COMMIT outcome`);
    },
    close: () => database.close(),
  };
}

function brokerGraphCounts(databasePath: string): Readonly<{
  artifacts: number;
  pins: number;
  routes: number;
  generations: number;
}> {
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (table: string, where = ""): number => {
      const row = inspection.prepare(`SELECT count(*) AS count FROM ${table} ${where}`).get() as {
        count: number;
      };
      return row.count;
    };
    return Object.freeze({
      artifacts: count(
        "protected_artifacts",
        `WHERE artifact_schema_id = '${BROKER_BACKEND_CAPABILITIES_SCHEMA_ID}'`,
      ),
      pins: count("broker_backend_capability_pins"),
      routes: count("broker_routes"),
      generations: count("broker_channel_generations"),
    });
  } finally {
    inspection.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.6 secure dormant broker-route SQLite integration", () => {
  it("exposes only the closed broker-route repository and no SQL constructor", () => {
    expect(sqliteExports).not.toHaveProperty("createBrokerRouteRepositoryOperations");
    expect(sqliteExports).not.toHaveProperty("createBrokerRouteRepositoryTransactionOperations");
    expect(sqliteExports).not.toHaveProperty("validateBrokerRouteRepositorySnapshot");
  });

  it("allows an unpinned generic capability-schema artifact to survive secure reopen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const capabilityBytes = canonicalBrokerBackendCapabilitiesV1(
      REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
    );
    const capabilityDigest = syncBrokerBackendCapabilitiesDigestV1(
      REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
    );
    await database.putArtifact({
      scopeKind: "host_profile",
      scopeId: "default",
      artifactSchemaId: BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
      artifactDigest: capabilityDigest,
      artifactBytes: ProtectedByteSnapshot.from(capabilityBytes),
    });
    expect(database.brokerRoute.readInventory()).toEqual({
      capabilityPins: [],
      routes: [],
      generations: [],
    });
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(reopened.brokerRoute.readInventory()).toEqual({
      capabilityPins: [],
      routes: [],
      generations: [],
    });
    reopened.close();
  });

  it("retries exactly one unknown remote open and installs one local graph", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const graph = establishChat(database);
    const remote = fakeNegotiatedClient({ storeFill: 70, unknownFirst: true });
    const reopenDatabase = vi.fn(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      }),
    );

    const result = await openAndInstallDormantBrokerRoute({
      database,
      reopenDatabase,
      client: remote.client,
      fence: {
        collaborationServerId: graph.server.collaborationServerId,
        coordinatorLeaseId: graph.acquisition.lease.coordinatorLeaseId,
        coordinatorEpoch: graph.acquisition.lease.coordinatorEpoch,
      },
      routeKind: "chat",
      logicalChatId: graph.chat.logicalChatId,
      nowMs: () => NOW_MS,
    });

    expect(result.remoteOpenAttempts).toBe(2);
    expect(result.reconciledAfterUnknownCommit).toBe(false);
    expect(remote.openRoute).toHaveBeenCalledTimes(2);
    expect(remote.openRoute.mock.calls.map((call) => call[1])).toEqual([
      { expectedRouteStoreInstanceId: null },
      { expectedRouteStoreInstanceId: null },
    ]);
    expect(reopenDatabase).not.toHaveBeenCalled();
    result.database.close();
    expect(brokerGraphCounts(state.paths.databasePath)).toEqual({
      artifacts: 1,
      pins: 1,
      routes: 1,
      generations: 1,
    });
  });

  it("does not retry a known remote failure and bounds repeated unknown outcomes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const graph = establishChat(database);
    const fence = {
      collaborationServerId: graph.server.collaborationServerId,
      coordinatorLeaseId: graph.acquisition.lease.coordinatorLeaseId,
      coordinatorEpoch: graph.acquisition.lease.coordinatorEpoch,
    };
    const capabilityDigest = syncBrokerBackendCapabilitiesDigestV1(
      REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
    );
    const reopenDatabase = () =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      });
    const knownFailure = new Error("known remote failure");
    const knownOpen = vi.fn(async (): Promise<A1BrokerRouteHandle> => {
      throw knownFailure;
    });
    const knownClient: A1BrokerNegotiatedClient = {
      brokerOrigin: "https://broker.example",
      brokerBackendCapabilitiesDigest: capabilityDigest,
      openRoute: knownOpen,
    };
    await expect(
      openAndInstallDormantBrokerRoute({
        database,
        reopenDatabase,
        client: knownClient,
        fence,
        routeKind: "chat",
        logicalChatId: graph.chat.logicalChatId,
        nowMs: () => NOW_MS,
      }),
    ).rejects.toBe(knownFailure);
    expect(knownOpen).toHaveBeenCalledTimes(1);

    const unknownOpen = vi.fn(async (): Promise<A1BrokerRouteHandle> => {
      throw new A1BrokerOutcomeUnknownError();
    });
    const unknownClient: A1BrokerNegotiatedClient = {
      brokerOrigin: "https://broker.example",
      brokerBackendCapabilitiesDigest: capabilityDigest,
      openRoute: unknownOpen,
    };
    await expect(
      openAndInstallDormantBrokerRoute({
        database,
        reopenDatabase,
        client: unknownClient,
        fence,
        routeKind: "chat",
        logicalChatId: graph.chat.logicalChatId,
        nowMs: () => NOW_MS,
      }),
    ).rejects.toBeInstanceOf(A1BrokerOutcomeUnknownError);
    expect(unknownOpen).toHaveBeenCalledTimes(2);
    expect(database.brokerRoute.readInventory()).toEqual({
      capabilityPins: [],
      routes: [],
      generations: [],
    });
    database.close();
  });

  it("reconciles a landed unknown local COMMIT without replaying the mutation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const graph = establishChat(database);
    const remote = fakeNegotiatedClient({ storeFill: 71 });
    const reopenDatabase = vi.fn(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      }),
    );

    const result = await openAndInstallDormantBrokerRoute({
      database: unknownCommitDatabase(database, "landed"),
      reopenDatabase,
      client: remote.client,
      fence: {
        collaborationServerId: graph.server.collaborationServerId,
        coordinatorLeaseId: graph.acquisition.lease.coordinatorLeaseId,
        coordinatorEpoch: graph.acquisition.lease.coordinatorEpoch,
      },
      routeKind: "chat",
      logicalChatId: graph.chat.logicalChatId,
      nowMs: () => NOW_MS,
    });

    expect(result.reconciledAfterUnknownCommit).toBe(true);
    expect(result.installation.replayed).toBe(true);
    expect(reopenDatabase).toHaveBeenCalledTimes(1);
    expect(remote.openRoute).toHaveBeenCalledTimes(1);
    result.database.close();
    expect(brokerGraphCounts(state.paths.databasePath)).toEqual({
      artifacts: 1,
      pins: 1,
      routes: 1,
      generations: 1,
    });
  });

  it("proves an unknown local COMMIT absent after rollback and never retries it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const graph = establishChat(database);
    const remote = fakeNegotiatedClient({ storeFill: 72 });
    const reopenDatabase = vi.fn(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      }),
    );

    await expect(
      openAndInstallDormantBrokerRoute({
        database: unknownCommitDatabase(database, "absent"),
        reopenDatabase,
        client: remote.client,
        fence: {
          collaborationServerId: graph.server.collaborationServerId,
          coordinatorLeaseId: graph.acquisition.lease.coordinatorLeaseId,
          coordinatorEpoch: graph.acquisition.lease.coordinatorEpoch,
        },
        routeKind: "chat",
        logicalChatId: graph.chat.logicalChatId,
        nowMs: () => NOW_MS,
      }),
    ).rejects.toBeInstanceOf(DormantBrokerRouteCommitAbsentError);

    expect(reopenDatabase).toHaveBeenCalledTimes(1);
    expect(remote.openRoute).toHaveBeenCalledTimes(1);
    expect(brokerGraphCounts(state.paths.databasePath)).toEqual({
      artifacts: 0,
      pins: 0,
      routes: 0,
      generations: 0,
    });
    const verified = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(verified.brokerRoute.readInventory()).toEqual({
      capabilityPins: [],
      routes: [],
      generations: [],
    });
    verified.close();
  });

  it("reconciles a historical route and reuses its pin after successor takeover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const graph = establishChat(database);
    const initialRemote = fakeNegotiatedClient({ storeFill: 73 });
    const initialFence = {
      collaborationServerId: graph.server.collaborationServerId,
      coordinatorLeaseId: graph.acquisition.lease.coordinatorLeaseId,
      coordinatorEpoch: graph.acquisition.lease.coordinatorEpoch,
    };
    const reopenDatabase = () =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      });
    const first = await openAndInstallDormantBrokerRoute({
      database,
      reopenDatabase,
      client: initialRemote.client,
      fence: initialFence,
      routeKind: "chat",
      logicalChatId: graph.chat.logicalChatId,
      nowMs: () => NOW_MS,
    });

    database.records.releaseCoordinatorLease({ fence: initialFence });
    vi.setSystemTime(NOW_MS + 1);
    const successor = database.records.acquireCoordinatorLease({
      collaborationServerId: graph.server.collaborationServerId,
      candidateLeaseId: canonicalId("coordinatorLease", 42),
      ownerInstanceId: parseA1SafeId("a16-broker-route-successor"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 1,
      leaseDurationMs: 600_000,
    });
    const successorFence = {
      collaborationServerId: graph.server.collaborationServerId,
      coordinatorLeaseId: successor.lease.coordinatorLeaseId,
      coordinatorEpoch: successor.lease.coordinatorEpoch,
    };

    const historicalRemote = fakeNegotiatedClient({
      storeFill: 73,
      disposition: "existing",
    });
    const historical = await openAndInstallDormantBrokerRoute({
      database,
      reopenDatabase,
      client: historicalRemote.client,
      fence: successorFence,
      routeKind: "chat",
      logicalChatId: graph.chat.logicalChatId,
      nowMs: () => NOW_MS + 1,
    });
    expect(historical.installation).toEqual({ ...first.installation, replayed: true });
    expect(historicalRemote.openRoute.mock.calls[0]?.[1]).toEqual({
      expectedRouteStoreInstanceId: first.installation.route.brokerRouteStoreInstanceId,
    });

    const transplantedStore = fakeNegotiatedClient({ storeFill: 73 });
    await expect(
      openAndInstallDormantBrokerRoute({
        database,
        reopenDatabase,
        client: transplantedStore.client,
        fence: successorFence,
        routeKind: "server_control",
        logicalChatId: null,
        nowMs: () => NOW_MS + 1,
      }),
    ).rejects.toThrow(/store instance is already retained/);
    expect(database.brokerRoute.readInventory().routes).toHaveLength(1);

    const successorRemote = fakeNegotiatedClient({ storeFill: 74 });
    const second = await openAndInstallDormantBrokerRoute({
      database,
      reopenDatabase,
      client: successorRemote.client,
      fence: successorFence,
      routeKind: "server_control",
      logicalChatId: null,
      nowMs: () => NOW_MS + 1,
    });
    expect(second.installation.capabilityPin).toEqual(first.installation.capabilityPin);
    expect(second.installation.route).toMatchObject({
      coordinatorLeaseId: successor.lease.coordinatorLeaseId,
      coordinatorEpoch: 2,
      createdAtMs: NOW_MS + 1,
    });
    database.close();

    const reopened = reopenDatabase();
    expect(reopened.brokerRoute.readInventory()).toMatchObject({
      capabilityPins: [first.installation.capabilityPin],
    });
    expect(reopened.brokerRoute.readInventory().routes).toHaveLength(2);
    reopened.close();
    expect(brokerGraphCounts(state.paths.databasePath)).toEqual({
      artifacts: 1,
      pins: 1,
      routes: 2,
      generations: 2,
    });
  });

  it("rolls back nonempty and route-drifted remote adoption without poisoning SQLite", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const graph = establishChat(database);
    const fence = {
      collaborationServerId: graph.server.collaborationServerId,
      coordinatorLeaseId: graph.acquisition.lease.coordinatorLeaseId,
      coordinatorEpoch: graph.acquisition.lease.coordinatorEpoch,
    };
    const reopenDatabase = () =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      });
    const nonempty = fakeNegotiatedClient({
      storeFill: 75,
      disposition: "existing",
      mutateReceipt: (receipt) => ({ ...receipt, observedNextFrameIndex: 1 }),
    });
    await expect(
      openAndInstallDormantBrokerRoute({
        database,
        reopenDatabase,
        client: nonempty.client,
        fence,
        routeKind: "chat",
        logicalChatId: graph.chat.logicalChatId,
        nowMs: () => NOW_MS,
      }),
    ).rejects.toThrow(/observedNextFrameIndex must equal 0/);
    expect(database.brokerRoute.readInventory()).toEqual({
      capabilityPins: [],
      routes: [],
      generations: [],
    });

    const changedRouteId = `rcr_${base64urlEncode(new Uint8Array(32).fill(88))}`;
    const routeDrift = fakeNegotiatedClient({
      storeFill: 75,
      mutateReceipt: (receipt) => ({
        ...receipt,
        route: { ...receipt.route, brokerRouteId: changedRouteId },
        genesis: { ...receipt.genesis, brokerRouteId: changedRouteId },
        currentGeneration: { ...receipt.currentGeneration, brokerRouteId: changedRouteId },
      }),
    });
    await expect(
      openAndInstallDormantBrokerRoute({
        database,
        reopenDatabase,
        client: routeDrift.client,
        fence,
        routeKind: "chat",
        logicalChatId: graph.chat.logicalChatId,
        nowMs: () => NOW_MS,
      }),
    ).rejects.toThrow(/exactly confirm the selected route/);
    expect(database.brokerRoute.readInventory()).toEqual({
      capabilityPins: [],
      routes: [],
      generations: [],
    });

    const accepted = fakeNegotiatedClient({ storeFill: 75 });
    const installed = await openAndInstallDormantBrokerRoute({
      database,
      reopenDatabase,
      client: accepted.client,
      fence,
      routeKind: "chat",
      logicalChatId: graph.chat.logicalChatId,
      nowMs: () => NOW_MS,
    });
    expect(installed.installation.replayed).toBe(false);
    database.close();
    expect(brokerGraphCounts(state.paths.databasePath)).toEqual({
      artifacts: 1,
      pins: 1,
      routes: 1,
      generations: 1,
    });
  });

  it("composes capability artifact + route install atomically and reconciles after reopen", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const graph = establishChat(database);
    const capabilityBytes = canonicalBrokerBackendCapabilitiesV1(
      REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
    );
    const capabilityDigest = syncBrokerBackendCapabilitiesDigestV1(
      REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
    );

    expect(() =>
      database.transaction((transaction) => {
        const artifact = transaction.putArtifact({
          scopeKind: "host_profile",
          scopeId: "default",
          artifactSchemaId: BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
          artifactDigest: capabilityDigest,
          artifactBytes: ProtectedByteSnapshot.from(capabilityBytes),
        });
        transaction.brokerRoute.install(
          routeRequest(
            graph.server.collaborationServerId,
            graph.chat.logicalChatId,
            graph.acquisition.lease.coordinatorLeaseId,
            artifact.artifactRef.protectedHandleId,
          ),
        );
        throw new Error("abort route composition");
      }),
    ).toThrow("abort route composition");
    expect(database.brokerRoute.readInventory()).toEqual({
      capabilityPins: [],
      routes: [],
      generations: [],
    });

    const installed = database.transaction((transaction) => {
      const artifact = transaction.putArtifact({
        scopeKind: "host_profile",
        scopeId: "default",
        artifactSchemaId: BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
        artifactDigest: capabilityDigest,
        artifactBytes: ProtectedByteSnapshot.from(capabilityBytes),
      });
      return transaction.brokerRoute.install(
        routeRequest(
          graph.server.collaborationServerId,
          graph.chat.logicalChatId,
          graph.acquisition.lease.coordinatorLeaseId,
          artifact.artifactRef.protectedHandleId,
        ),
      );
    });
    expect(installed.replayed).toBe(false);
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(reopened.schemaVersion).toBe(10);
    expect(reopened.brokerRoute.readInstallation(installed.route.brokerRouteId)).toEqual({
      ...installed,
      replayed: true,
    });
    reopened.close();

    const inspection = new DatabaseSync(state.paths.databasePath, { readOnly: true });
    try {
      const brokerTables = inspection
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name LIKE 'broker_%' ORDER BY name`,
        )
        .all();
      expect(brokerTables).toEqual([
        { name: "broker_backend_capability_pins" },
        { name: "broker_channel_generation_observations" },
        { name: "broker_channel_generations" },
        { name: "broker_channel_manifest_equivocations" },
        { name: "broker_read_page_frame_evidence" },
        { name: "broker_read_page_observations" },
        { name: "broker_route_actors" },
        { name: "broker_route_fetch_cursors" },
        { name: "broker_route_gaps" },
        { name: "broker_route_runtime_status" },
        { name: "broker_route_semantic_cursors" },
        { name: "broker_routes" },
        { name: "broker_transport_key_collisions" },
      ]);
      for (const forbidden of [
        "collaboration_command_results",
        "ingress_result_deliveries",
        "host_output_deliveries",
        "native_dispatch_attempts",
        "effect_gates",
      ]) {
        expect(
          inspection
            .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
            .get(forbidden),
        ).toBeUndefined();
      }
    } finally {
      inspection.close();
    }
  });

  it("fails secure reopen when an empty-genesis route graph is corrupted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const graph = establishChat(database);
    const capabilityBytes = canonicalBrokerBackendCapabilitiesV1(
      REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
    );
    const capabilityDigest = syncBrokerBackendCapabilitiesDigestV1(
      REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
    );
    database.transaction((transaction) => {
      const artifact = transaction.putArtifact({
        scopeKind: "host_profile",
        scopeId: "default",
        artifactSchemaId: BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
        artifactDigest: capabilityDigest,
        artifactBytes: ProtectedByteSnapshot.from(capabilityBytes),
      });
      transaction.brokerRoute.install(
        routeRequest(
          graph.server.collaborationServerId,
          graph.chat.logicalChatId,
          graph.acquisition.lease.coordinatorLeaseId,
          artifact.artifactRef.protectedHandleId,
        ),
      );
    });
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      const row = editor
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'trigger' AND name = 'broker_channel_generations_no_delete'`,
        )
        .get() as { sql: string };
      editor.exec("DROP TRIGGER broker_channel_generations_no_delete");
      editor.prepare("DELETE FROM broker_channel_generations").run();
      editor.exec(row.sql);
    } finally {
      editor.close();
    }

    expect(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      }),
    ).toThrow(/broker-route records failed semantic validation/);
  });
});
