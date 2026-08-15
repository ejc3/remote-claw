import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
  canonicalBrokerBackendCapabilitiesV1,
  REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
} from "./backend.js";
import {
  type BrokerRouteKind,
  deriveBrokerRouteId,
  deriveBrokerRouteToken,
  type InstallBrokerRouteRequest,
  parseBrokerRouteStoreInstanceId,
  syncBrokerBackendCapabilitiesDigestV1,
} from "./broker-route.js";
import {
  BrokerRouteRepositoryConflictError,
  BrokerRouteRepositoryPersistenceError,
  BrokerRouteStaleCoordinatorError,
  createBrokerRouteRepositoryOperations,
  validateBrokerRouteRepositorySnapshot,
} from "./broker-route-repository.js";
import { type LogicalChatId, parseA1CanonicalId, parseA1Digest } from "./ids.js";
import { HOST_STATE_MIGRATIONS } from "./migrations.js";
import type {
  HostStateRepositorySqlTransaction,
  HostStateRepositoryTransactionExecutor,
} from "./repository.js";

const MACHINE_IDENTITY_ID = "01".repeat(16);
const SERVER_ID = parseA1CanonicalId(
  "collaborationServer",
  `rcs_${base64urlEncode(new Uint8Array(16).fill(2))}`,
);
const CHAT_ID = parseA1CanonicalId(
  "logicalChat",
  `rcl_${base64urlEncode(new Uint8Array(16).fill(3))}`,
);
const SECOND_CHAT_ID = parseA1CanonicalId(
  "logicalChat",
  `rcl_${base64urlEncode(new Uint8Array(16).fill(13))}`,
);
const PROJECT_ID = parseA1CanonicalId(
  "project",
  `rcpj_${base64urlEncode(new Uint8Array(16).fill(4))}`,
);
const MAPPING_ID = parseA1CanonicalId(
  "projectTargetSelectorMapping",
  `ptm_${base64urlEncode(new Uint8Array(32).fill(5))}`,
);
const REGISTRATION_ID = parseA1CanonicalId(
  "registrationAttempt",
  `rcra_${base64urlEncode(new Uint8Array(16).fill(6))}`,
);
const LEASE_ID = parseA1CanonicalId(
  "coordinatorLease",
  `rccl_${base64urlEncode(new Uint8Array(16).fill(7))}`,
);
const SUCCESSOR_LEASE_ID = parseA1CanonicalId(
  "coordinatorLease",
  `rccl_${base64urlEncode(new Uint8Array(16).fill(17))}`,
);
const BINDING_ID = parseA1CanonicalId(
  "nativeBinding",
  `rcnb_${base64urlEncode(new Uint8Array(16).fill(9))}`,
);
const EDGE_ID = parseA1CanonicalId(
  "inwardEdge",
  `rcie_${base64urlEncode(new Uint8Array(16).fill(10))}`,
);
const SECOND_BINDING_ID = parseA1CanonicalId(
  "nativeBinding",
  `rcnb_${base64urlEncode(new Uint8Array(16).fill(14))}`,
);
const SECOND_EDGE_ID = parseA1CanonicalId(
  "inwardEdge",
  `rcie_${base64urlEncode(new Uint8Array(16).fill(15))}`,
);
const ARTIFACT_ID = parseA1CanonicalId(
  "protectedHandle",
  `rcph_${base64urlEncode(new Uint8Array(16).fill(8))}`,
);
const DIGEST = syncBrokerBackendCapabilitiesDigestV1(REQUIRED_BROKER_BACKEND_CAPABILITIES_V1);
const CAPABILITY_BYTES = canonicalBrokerBackendCapabilitiesV1(
  REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
);

class SqliteExecutor implements HostStateRepositoryTransactionExecutor {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  transaction<T>(operation: (transaction: HostStateRepositorySqlTransaction) => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    const transaction: HostStateRepositorySqlTransaction = {
      get: (sql, parameters) => this.database.prepare(sql).get(...parameters),
      all: (sql, parameters) => this.database.prepare(sql).all(...parameters),
      run: (sql, parameters) => {
        const result = this.database.prepare(sql).run(...parameters);
        return { changes: result.changes };
      },
    };
    try {
      const result = operation(transaction);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const databases: DatabaseSync[] = [];

function fixture(): { database: DatabaseSync; executor: SqliteExecutor } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA recursive_triggers=ON");
  for (const migration of HOST_STATE_MIGRATIONS) {
    for (const statement of migration.statements) database.exec(statement);
  }
  database
    .prepare(
      `INSERT INTO host_state_metadata
         (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
       VALUES (1, ?, 7, ?, 1)`,
    )
    .run(MACHINE_IDENTITY_ID, "A".repeat(43));
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO collaboration_servers (
          collaboration_server_id, machine_identity_id, current_key_generation,
          current_identity_key_id, current_scope_certificate_id,
          current_coordinator_epoch, current_coordinator_lease_id,
          next_journal_offset, next_server_signature_seq, next_command_seq,
          created_at_ms, state
        ) VALUES (?, ?, 0, NULL, NULL, 1, ?, 0, 0, 0, 1, 'installing')`,
      )
      .run(SERVER_ID, MACHINE_IDENTITY_ID, LEASE_ID);
    database
      .prepare(
        `INSERT INTO coordinator_leases (
          coordinator_lease_id, collaboration_server_id, coordinator_epoch,
          owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
          heartbeat_deadline_ms, released_at_ms, state
        ) VALUES (?, ?, 1, 'owner-1', 10, 100, 100, NULL, 'current')`,
      )
      .run(LEASE_ID, SERVER_ID);
    database
      .prepare(
        `INSERT INTO host_state_profiles (
          state_profile_id, machine_identity_id, default_collaboration_server_id, created_at_ms
        ) VALUES ('default', ?, ?, 1)`,
      )
      .run(MACHINE_IDENTITY_ID, SERVER_ID);
    database
      .prepare(
        `INSERT INTO project_target_selector_mappings (
          project_target_selector_mapping_id, collaboration_server_id, project_id,
          workspace_selector_id, target_kind, target_product, target_access,
          terminal_project_ref, native_workspace_binding_id,
          nested_server_management_binding_id, target_server_id, target_project_id,
          target_workspace_selector_id, target_digest, mapping_generation, evidence_ref, state
        ) VALUES (?, ?, ?, 'workspace-1', 'terminal_native', 'codex', 'app-server',
                  'terminal-project-1', NULL, NULL, NULL, NULL, NULL, ?, 1, 'evidence-1', 'current')`,
      )
      .run(MAPPING_ID, SERVER_ID, PROJECT_ID, "B".repeat(43));
    database
      .prepare(
        `INSERT INTO projects (
          project_id, collaboration_server_id, project_allocation_intent_id,
          project_allocation_intent_schema_id, project_allocation_intent_digest,
          allocation_kind, initial_workspace_selector_id, initial_target_digest,
          initial_project_target_selector_mapping_id, initial_mapping_generation,
          initial_target_kind, created_at_ms, state
        ) VALUES (?, ?, ?, 'remote-claw/project-allocation-intent/v1', ?,
                  'first_bootstrap', 'workspace-1', ?, ?, 1, 'terminal_native', 2, 'current')`,
      )
      .run(PROJECT_ID, SERVER_ID, REGISTRATION_ID, "C".repeat(43), "B".repeat(43), MAPPING_ID);
    database
      .prepare(
        `INSERT INTO logical_chats (
          logical_chat_id, collaboration_server_id, project_id,
          project_target_selector_mapping_id, state, topology_generation,
          current_inward_edge_id, current_native_binding_id, parent_chat_id,
          next_viewer_projection_seq
        ) VALUES (?, ?, ?, ?, 'recovering', 1, ?, ?, NULL, 0)`,
      )
      .run(CHAT_ID, SERVER_ID, PROJECT_ID, MAPPING_ID, EDGE_ID, BINDING_ID);
    database
      .prepare(
        `INSERT INTO native_bindings (
          native_binding_id, collaboration_server_id, logical_chat_id,
          descriptor_product, descriptor_access, project_id, semantic_conversation_id,
          current_binding_incarnation_id, state
        ) VALUES (?, ?, ?, 'codex', 'app-server', ?, NULL, NULL, 'starting')`,
      )
      .run(BINDING_ID, SERVER_ID, CHAT_ID, PROJECT_ID);
    database
      .prepare(
        `INSERT INTO inward_collaboration_edges (
          inward_edge_id, represented_server_id, represented_logical_chat_id,
          target_kind, target_server_id, target_logical_chat_id, target_native_binding_id,
          root_path_certificate_id, current_connection_epoch, current_live_lease_id,
          current_capability_snapshot_id, state
        ) VALUES (?, ?, ?, 'native-harness', NULL, NULL, ?, NULL, 0, NULL, NULL, 'installing')`,
      )
      .run(EDGE_ID, SERVER_ID, CHAT_ID, BINDING_ID);
    database
      .prepare(
        `INSERT INTO logical_chats (
          logical_chat_id, collaboration_server_id, project_id,
          project_target_selector_mapping_id, state, topology_generation,
          current_inward_edge_id, current_native_binding_id, parent_chat_id,
          next_viewer_projection_seq
        ) VALUES (?, ?, ?, ?, 'recovering', 1, ?, ?, NULL, 0)`,
      )
      .run(SECOND_CHAT_ID, SERVER_ID, PROJECT_ID, MAPPING_ID, SECOND_EDGE_ID, SECOND_BINDING_ID);
    database
      .prepare(
        `INSERT INTO native_bindings (
          native_binding_id, collaboration_server_id, logical_chat_id,
          descriptor_product, descriptor_access, project_id, semantic_conversation_id,
          current_binding_incarnation_id, state
        ) VALUES (?, ?, ?, 'codex', 'app-server', ?, NULL, NULL, 'starting')`,
      )
      .run(SECOND_BINDING_ID, SERVER_ID, SECOND_CHAT_ID, PROJECT_ID);
    database
      .prepare(
        `INSERT INTO inward_collaboration_edges (
          inward_edge_id, represented_server_id, represented_logical_chat_id,
          target_kind, target_server_id, target_logical_chat_id, target_native_binding_id,
          root_path_certificate_id, current_connection_epoch, current_live_lease_id,
          current_capability_snapshot_id, state
        ) VALUES (?, ?, ?, 'native-harness', NULL, NULL, ?, NULL, 0, NULL, NULL, 'installing')`,
      )
      .run(SECOND_EDGE_ID, SERVER_ID, SECOND_CHAT_ID, SECOND_BINDING_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  database
    .prepare(
      `INSERT INTO protected_artifacts (
        protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
        artifact_digest, byte_length, artifact_bytes, created_at_ms
      ) VALUES (?, 'artifact', 'host_profile', 'default', ?, ?, ?, ?, 20)`,
    )
    .run(
      ARTIFACT_ID,
      BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
      DIGEST,
      CAPABILITY_BYTES.byteLength,
      CAPABILITY_BYTES,
    );
  return { database, executor: new SqliteExecutor(database) };
}

function request(
  routeKind: BrokerRouteKind,
  storeFill: number,
  logicalChatId: LogicalChatId | null = routeKind === "chat" ? CHAT_ID : null,
): InstallBrokerRouteRequest {
  const brokerRouteId = deriveBrokerRouteId(
    MACHINE_IDENTITY_ID,
    SERVER_ID,
    routeKind,
    logicalChatId,
  );
  const routeToken = deriveBrokerRouteToken(
    MACHINE_IDENTITY_ID,
    SERVER_ID,
    routeKind,
    logicalChatId,
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
    fence: {
      collaborationServerId: SERVER_ID,
      coordinatorLeaseId: LEASE_ID,
      coordinatorEpoch: 1,
    },
    routeKind,
    logicalChatId,
    brokerOrigin: "https://broker.example",
    brokerBackendSelector: "sqlite",
    capabilityArtifactRef: { protectedHandleId: ARTIFACT_ID, kind: "artifact" },
    capabilityObservedAtMs: 20,
    routeOpenedAtMs: 20,
    receipt: {
      schemaVersion: 1,
      disposition: "created",
      route: {
        schemaVersion: 1,
        brokerOrigin: "https://broker.example",
        backendSelector: "sqlite",
        routeStoreInstanceId: parseBrokerRouteStoreInstanceId(
          `rbsi_${base64urlEncode(new Uint8Array(16).fill(storeFill))}`,
        ),
        identityId: MACHINE_IDENTITY_ID,
        collaborationServerId: SERVER_ID,
        routeKind,
        logicalChatId,
        brokerRouteId,
        routeToken,
        brokerBackendCapabilitiesDigest: DIGEST,
      },
      genesis: generation,
      currentGeneration: generation,
      observedNextFrameIndex: 0,
    },
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("dormant schema-v7 broker-route repository", () => {
  it("atomically installs a pin, route, and empty open genesis, then exactly replays", () => {
    const { executor } = fixture();
    const repository = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    const input = request("chat", 11);
    const installed = repository.install(input);
    expect(installed).toMatchObject({
      replayed: false,
      route: {
        routeKind: "chat",
        logicalChatId: CHAT_ID,
        state: "current",
        genesisGeneration: 0,
      },
      genesis: {
        channelGeneration: 0,
        state: "open",
        frameCount: null,
      },
    });
    expect(
      repository.install({ ...input, receipt: { ...input.receipt, disposition: "existing" } }),
    ).toEqual({ ...installed, replayed: true });
    expect(repository.reconcileInstall(input)).toEqual({ ...installed, replayed: true });
    expect(repository.readInstallation(installed.route.brokerRouteId)).toEqual({
      ...installed,
      replayed: true,
    });
    expect(repository.readInventory()).toMatchObject({
      capabilityPins: [{ canonicalPayloadRef: ARTIFACT_ID }],
      routes: [{ brokerRouteId: installed.route.brokerRouteId }],
      generations: [{ brokerRouteId: installed.route.brokerRouteId }],
    });
  });

  it("isolates the bus, server-control, and chat route tuples and store identities", () => {
    const { executor } = fixture();
    const repository = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    const routes = [
      repository.install(request("scope_bus", 21)).route,
      repository.install(request("server_control", 22)).route,
      repository.install(request("chat", 23)).route,
      repository.install(request("chat", 24, SECOND_CHAT_ID)).route,
    ];
    expect(new Set(routes.map((route) => route.brokerRouteId))).toHaveLength(4);
    expect(new Set(routes.map((route) => route.routeToken))).toHaveLength(4);
    expect(new Set(routes.map((route) => route.brokerRouteStoreInstanceId))).toHaveLength(4);
    expect(repository.readInventory()).toMatchObject({
      capabilityPins: [{ canonicalPayloadRef: ARTIFACT_ID }],
    });
    expect(repository.readInventory().routes).toHaveLength(4);
  });

  it("rejects a transplanted broker store without poisoning later route installation", () => {
    const { executor } = fixture();
    const repository = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    const first = repository.install(request("chat", 25));
    expect(() => repository.install(request("server_control", 25))).toThrow(
      BrokerRouteRepositoryConflictError,
    );
    const second = repository.install(request("server_control", 26));
    expect(second.route.brokerRouteStoreInstanceId).not.toBe(
      first.route.brokerRouteStoreInstanceId,
    );
    expect(repository.readInventory().routes).toHaveLength(2);
  });

  it("reuses the retained capability pin after a same-ms release and successor takeover", () => {
    const { database, executor } = fixture();
    const repository = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    const first = repository.install(request("chat", 25));

    database
      .prepare(
        `UPDATE coordinator_leases
            SET released_at_ms = 20, state = 'released'
          WHERE coordinator_lease_id = ?`,
      )
      .run(LEASE_ID);
    database
      .prepare(
        `UPDATE collaboration_servers
            SET current_coordinator_lease_id = NULL
          WHERE collaboration_server_id = ?`,
      )
      .run(SERVER_ID);
    database
      .prepare(
        `INSERT INTO coordinator_leases (
          coordinator_lease_id, collaboration_server_id, coordinator_epoch,
          owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
          heartbeat_deadline_ms, released_at_ms, state
        ) VALUES (?, ?, 2, 'owner-2', 20, 100, 100, NULL, 'current')`,
      )
      .run(SUCCESSOR_LEASE_ID, SERVER_ID);
    database
      .prepare(
        `UPDATE collaboration_servers
            SET current_coordinator_lease_id = ?, current_coordinator_epoch = 2
          WHERE collaboration_server_id = ?`,
      )
      .run(SUCCESSOR_LEASE_ID, SERVER_ID);

    const second = repository.install({
      ...request("server_control", 26),
      fence: {
        collaborationServerId: SERVER_ID,
        coordinatorLeaseId: SUCCESSOR_LEASE_ID,
        coordinatorEpoch: 2,
      },
      capabilityObservedAtMs: 20,
      routeOpenedAtMs: 40,
    });
    expect(second.capabilityPin).toEqual(first.capabilityPin);
    expect(second.route).toMatchObject({
      coordinatorLeaseId: SUCCESSOR_LEASE_ID,
      coordinatorEpoch: 2,
      createdAtMs: 40,
    });
    expect(repository.readInventory()).toMatchObject({
      capabilityPins: [first.capabilityPin],
    });
    expect(repository.readInventory().routes).toHaveLength(2);
    executor.transaction((transaction) =>
      validateBrokerRouteRepositorySnapshot(transaction, MACHINE_IDENTITY_ID, 7),
    );
  });

  it("rejects changed durable fields as collisions without changing the exact graph", () => {
    const { executor } = fixture();
    const repository = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    const input = request("chat", 31);
    const installed = repository.install(input);
    const changedStore = request("chat", 32);
    expect(() => repository.install(changedStore)).toThrow(BrokerRouteRepositoryConflictError);
    expect(() =>
      repository.install({
        ...input,
        brokerOrigin: "https://other-broker.example",
        receipt: {
          ...input.receipt,
          route: {
            ...input.receipt.route,
            brokerOrigin: "https://other-broker.example",
          },
        },
      }),
    ).toThrow(BrokerRouteRepositoryConflictError);
    expect(() =>
      repository.install({
        ...input,
        capabilityObservedAtMs: 19,
      }),
    ).toThrow(BrokerRouteRepositoryConflictError);
    expect(() =>
      repository.install({
        ...input,
        routeOpenedAtMs: 21,
      }),
    ).toThrow(BrokerRouteRepositoryConflictError);
    expect(() =>
      repository.install({
        ...input,
        brokerBackendSelector: "memory" as "sqlite",
      }),
    ).toThrow(/brokerBackendSelector/);
    expect(() =>
      repository.install({
        ...input,
        receipt: {
          ...input.receipt,
          route: {
            ...input.receipt.route,
            brokerBackendCapabilitiesDigest: parseA1Digest(
              base64urlEncode(new Uint8Array(32).fill(99)),
            ),
          },
        },
      }),
    ).toThrow(/exactly confirm/);
    expect(repository.readInstallation(installed.route.brokerRouteId)).toEqual({
      ...installed,
      replayed: true,
    });
  });

  it("rejects stale authority before writing and leaves the repository usable", () => {
    const { executor } = fixture();
    const stale = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 100,
    });
    expect(() => stale.install(request("chat", 41))).toThrow(BrokerRouteStaleCoordinatorError);
    expect(stale.readInventory()).toEqual({ capabilityPins: [], routes: [], generations: [] });
    const current = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    expect(current.install(request("chat", 41)).replayed).toBe(false);
  });

  it("rolls back a failed genesis insert with no orphan pin or route", () => {
    const { database, executor } = fixture();
    database.exec(`DROP TRIGGER broker_channel_generations_require_chain`);
    database.exec(`CREATE TRIGGER test_fail_genesis BEFORE INSERT ON broker_channel_generations
      BEGIN SELECT RAISE(ABORT, 'test genesis failure'); END`);
    const repository = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    expect(() => repository.install(request("chat", 51))).toThrow(
      BrokerRouteRepositoryPersistenceError,
    );
    expect(repository.readInventory()).toEqual({ capabilityPins: [], routes: [], generations: [] });
  });

  it("enforces current coordinator authority and prior capability observation in SQL", () => {
    const { database, executor } = fixture();
    const repository = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    const installed = repository.install(request("chat", 55));
    const routeId = deriveBrokerRouteId(MACHINE_IDENTITY_ID, SERVER_ID, "server_control", null);
    const token = deriveBrokerRouteToken(MACHINE_IDENTITY_ID, SERVER_ID, "server_control", null);
    expect(() =>
      database
        .prepare(
          `INSERT INTO broker_routes (
            broker_route_id, machine_identity_id, collaboration_server_id, route_kind,
            logical_chat_id, route_token, broker_origin, broker_backend_selector,
            broker_route_store_instance_id, genesis_generation,
            broker_backend_capabilities_ref, broker_backend_capabilities_digest,
            coordinator_lease_id, coordinator_epoch, created_at_ms, state
          ) VALUES (?, ?, ?, 'server_control', NULL, ?, ?, 'sqlite', ?, 0, ?, ?, ?, 1, 19, 'current')`,
        )
        .run(
          routeId,
          MACHINE_IDENTITY_ID,
          SERVER_ID,
          token,
          installed.route.brokerOrigin,
          parseBrokerRouteStoreInstanceId(`rbsi_${base64urlEncode(new Uint8Array(16).fill(56))}`),
          installed.capabilityPin.brokerBackendCapabilityPinId,
          installed.capabilityPin.canonicalPayloadDigest,
          LEASE_ID,
        ),
    ).toThrow(/prior capability pin/);
  });

  it("validates only a complete canonical schema-v7 snapshot", () => {
    const { database, executor } = fixture();
    const repository = createBrokerRouteRepositoryOperations(executor, MACHINE_IDENTITY_ID, {
      nowMs: () => 50,
    });
    repository.install(request("chat", 61));
    executor.transaction((transaction) =>
      validateBrokerRouteRepositorySnapshot(transaction, MACHINE_IDENTITY_ID, 7),
    );
    expect(() =>
      executor.transaction((transaction) =>
        validateBrokerRouteRepositorySnapshot(transaction, MACHINE_IDENTITY_ID, 6),
      ),
    ).toThrow(/schema version 6/);
    database.exec(`DROP TRIGGER broker_channel_generations_no_delete`);
    database.prepare("DELETE FROM broker_channel_generations").run();
    expect(() =>
      executor.transaction((transaction) =>
        validateBrokerRouteRepositorySnapshot(transaction, MACHINE_IDENTITY_ID, 7),
      ),
    ).toThrow(/exactly one empty open genesis/);
  });
});
