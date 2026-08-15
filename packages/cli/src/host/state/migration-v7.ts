import type { HostStateSqliteSchemaEntry } from "./migrations.js";

function schemaEntry(
  type: HostStateSqliteSchemaEntry["type"],
  name: string,
  tableName: string,
  sql: string,
): HostStateSqliteSchemaEntry {
  return Object.freeze({ type, name, tableName, sql });
}

const CREATE_BROKER_BACKEND_CAPABILITY_PINS_SQL = `CREATE TABLE broker_backend_capability_pins (
  broker_backend_capability_pin_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(broker_backend_capability_pin_id) = 48
    AND substr(broker_backend_capability_pin_id, 1, 5) = 'rbcp_'
    AND broker_backend_capability_pin_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  broker_origin TEXT NOT NULL CHECK (
    length(broker_origin) BETWEEN 1 AND 1024
  ),
  broker_backend_selector TEXT NOT NULL CHECK (broker_backend_selector = 'sqlite'),
  canonical_payload_schema_id TEXT NOT NULL CHECK (
    canonical_payload_schema_id = 'remote-claw/broker-backend-capabilities/v1'
  ),
  canonical_payload_ref TEXT NOT NULL CHECK (
    length(canonical_payload_ref) = 27
    AND substr(canonical_payload_ref, 1, 5) = 'rcph_'
    AND canonical_payload_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  canonical_payload_digest TEXT NOT NULL CHECK (
    length(canonical_payload_digest) = 43
    AND canonical_payload_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  observed_at_ms INTEGER NOT NULL CHECK (
    observed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  FOREIGN KEY (machine_identity_id)
    REFERENCES host_state_metadata (machine_identity_id),
  FOREIGN KEY (canonical_payload_ref)
    REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_ROUTES_SQL = `CREATE TABLE broker_routes (
  broker_route_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(broker_route_id) = 47
    AND substr(broker_route_id, 1, 4) = 'rcr_'
    AND broker_route_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  route_kind TEXT NOT NULL CHECK (route_kind IN ('scope_bus', 'server_control', 'chat')),
  logical_chat_id TEXT CHECK (
    logical_chat_id IS NULL OR (
      length(logical_chat_id) = 26
      AND substr(logical_chat_id, 1, 4) = 'rcl_'
      AND logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  route_token TEXT NOT NULL CHECK (
    length(route_token) BETWEEN 50 AND 51
    AND route_token NOT GLOB '*[^A-Za-z0-9_:-]*'
  ),
  broker_origin TEXT NOT NULL CHECK (
    length(broker_origin) BETWEEN 1 AND 1024
  ),
  broker_backend_selector TEXT NOT NULL CHECK (broker_backend_selector = 'sqlite'),
  broker_route_store_instance_id TEXT NOT NULL CHECK (
    length(broker_route_store_instance_id) = 27
    AND substr(broker_route_store_instance_id, 1, 5) = 'rbsi_'
    AND broker_route_store_instance_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  genesis_generation INTEGER NOT NULL CHECK (genesis_generation = 0),
  broker_backend_capabilities_ref TEXT NOT NULL CHECK (
    length(broker_backend_capabilities_ref) = 48
    AND substr(broker_backend_capabilities_ref, 1, 5) = 'rbcp_'
    AND broker_backend_capabilities_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  broker_backend_capabilities_digest TEXT NOT NULL CHECK (
    length(broker_backend_capabilities_digest) = 43
    AND broker_backend_capabilities_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_lease_id TEXT NOT NULL CHECK (
    length(coordinator_lease_id) = 27
    AND substr(coordinator_lease_id, 1, 5) = 'rccl_'
    AND coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'quarantined', 'closed')),
  CHECK (
    (route_kind IN ('scope_bus', 'server_control') AND logical_chat_id IS NULL)
    OR (route_kind = 'chat' AND logical_chat_id IS NOT NULL)
  ),
  CHECK (
    (route_kind = 'scope_bus' AND substr(route_token, 1, 7) = 'bus:a1:')
    OR (route_kind = 'server_control' AND substr(route_token, 1, 7) = 'ctl:a1:')
    OR (route_kind = 'chat' AND substr(route_token, 1, 8) = 'sess:a1:')
  ),
  FOREIGN KEY (machine_identity_id)
    REFERENCES host_state_metadata (machine_identity_id),
  FOREIGN KEY (collaboration_server_id, machine_identity_id)
    REFERENCES collaboration_servers (collaboration_server_id, machine_identity_id),
  FOREIGN KEY (collaboration_server_id, logical_chat_id)
    REFERENCES logical_chats (collaboration_server_id, logical_chat_id),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
    REFERENCES coordinator_leases (
      coordinator_lease_id,
      collaboration_server_id,
      coordinator_epoch
    ),
  FOREIGN KEY (
    broker_backend_capabilities_ref,
    machine_identity_id,
    broker_origin,
    broker_backend_selector,
    broker_backend_capabilities_digest
  ) REFERENCES broker_backend_capability_pins (
    broker_backend_capability_pin_id,
    machine_identity_id,
    broker_origin,
    broker_backend_selector,
    canonical_payload_digest
  )
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_CHANNEL_GENERATIONS_SQL = `CREATE TABLE broker_channel_generations (
  broker_route_id TEXT NOT NULL CHECK (
    length(broker_route_id) = 47
    AND substr(broker_route_id, 1, 4) = 'rcr_'
    AND broker_route_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  channel_generation INTEGER NOT NULL CHECK (
    channel_generation BETWEEN 0 AND 9007199254740991
  ),
  frame_count INTEGER CHECK (
    frame_count IS NULL OR frame_count BETWEEN 0 AND 9007199254740991
  ),
  next_generation INTEGER CHECK (
    next_generation IS NULL OR next_generation BETWEEN 1 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('open', 'sealed')),
  manifest_digest TEXT CHECK (
    manifest_digest IS NULL OR (
      length(manifest_digest) = 43
      AND manifest_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  PRIMARY KEY (broker_route_id, channel_generation),
  CHECK (
    (state = 'open'
      AND frame_count IS NULL
      AND next_generation IS NULL
      AND manifest_digest IS NULL)
    OR (state = 'sealed'
      AND frame_count IS NOT NULL
      AND next_generation = channel_generation + 1
      AND manifest_digest IS NOT NULL)
  ),
  FOREIGN KEY (broker_route_id)
    REFERENCES broker_routes (broker_route_id)
) STRICT, WITHOUT ROWID`;

const CREATE_CAPABILITY_PINS_COORDINATE_INDEX_SQL = `CREATE UNIQUE INDEX broker_backend_capability_pins_coordinate_unique
ON broker_backend_capability_pins (
  machine_identity_id,
  broker_origin,
  broker_backend_selector,
  canonical_payload_digest
)`;

const CREATE_CAPABILITY_PINS_ROUTE_REFERENCE_INDEX_SQL = `CREATE UNIQUE INDEX broker_backend_capability_pins_route_reference_unique
ON broker_backend_capability_pins (
  broker_backend_capability_pin_id,
  machine_identity_id,
  broker_origin,
  broker_backend_selector,
  canonical_payload_digest
)`;

const CREATE_BROKER_ROUTES_NON_CHAT_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX broker_routes_non_chat_scope_unique
ON broker_routes (machine_identity_id, collaboration_server_id, route_kind)
WHERE route_kind IN ('scope_bus', 'server_control')`;

const CREATE_BROKER_ROUTES_CHAT_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX broker_routes_chat_scope_unique
ON broker_routes (machine_identity_id, collaboration_server_id, route_kind, logical_chat_id)
WHERE route_kind = 'chat'`;

const CREATE_BROKER_ROUTES_TOKEN_INDEX_SQL = `CREATE UNIQUE INDEX broker_routes_token_unique
ON broker_routes (route_token)`;

const CREATE_BROKER_ROUTES_STORE_INDEX_SQL = `CREATE UNIQUE INDEX broker_routes_store_instance_unique
ON broker_routes (broker_route_store_instance_id)`;

const CREATE_BROKER_GENERATIONS_OPEN_INDEX_SQL = `CREATE UNIQUE INDEX broker_channel_generations_one_open_unique
ON broker_channel_generations (broker_route_id)
WHERE state = 'open'`;

const CREATE_CAPABILITY_PINS_REQUIRE_ARTIFACT_TRIGGER_SQL = `CREATE TRIGGER broker_backend_capability_pins_require_exact_artifact
BEFORE INSERT ON broker_backend_capability_pins
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
    WHERE artifact.protected_handle_id = NEW.canonical_payload_ref
      AND artifact.kind = 'artifact'
      AND artifact.scope_kind = 'host_profile'
      AND artifact.scope_id = 'default'
      AND artifact.artifact_schema_id = NEW.canonical_payload_schema_id
      AND artifact.artifact_digest = NEW.canonical_payload_digest
  ) THEN RAISE(ABORT, 'broker capability pin requires its exact host-profile artifact') END;
END`;

const CREATE_CAPABILITY_PINS_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_backend_capability_pins_no_update
BEFORE UPDATE ON broker_backend_capability_pins
BEGIN
  SELECT RAISE(ABORT, 'broker capability pins are immutable');
END`;

const CREATE_CAPABILITY_PINS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER broker_backend_capability_pins_no_delete
BEFORE DELETE ON broker_backend_capability_pins
BEGIN
  SELECT RAISE(ABORT, 'broker capability pins are retained');
END`;

const CREATE_CAPABILITY_PINS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER broker_backend_capability_pins_no_replace
BEFORE INSERT ON broker_backend_capability_pins
WHEN EXISTS (
  SELECT 1 FROM broker_backend_capability_pins
  WHERE broker_backend_capability_pin_id = NEW.broker_backend_capability_pin_id
)
BEGIN
  SELECT RAISE(ABORT, 'broker capability pins are immutable');
END`;

const CREATE_BROKER_ROUTES_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_routes_no_update
BEFORE UPDATE ON broker_routes
BEGIN
  SELECT RAISE(ABORT, 'schema-v7 broker routes are immutable');
END`;

const CREATE_BROKER_ROUTES_REQUIRE_CURRENT_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER broker_routes_require_current_authority
BEFORE INSERT ON broker_routes
BEGIN
  SELECT CASE WHEN NEW.state <> 'current' OR NOT EXISTS (
    SELECT 1
      FROM collaboration_servers AS server
      JOIN coordinator_leases AS lease
        ON lease.coordinator_lease_id = NEW.coordinator_lease_id
       AND lease.collaboration_server_id = NEW.collaboration_server_id
       AND lease.coordinator_epoch = NEW.coordinator_epoch
      JOIN broker_backend_capability_pins AS capability_pin
        ON capability_pin.broker_backend_capability_pin_id =
          NEW.broker_backend_capabilities_ref
       AND capability_pin.machine_identity_id = NEW.machine_identity_id
       AND capability_pin.broker_origin = NEW.broker_origin
       AND capability_pin.broker_backend_selector = NEW.broker_backend_selector
       AND capability_pin.canonical_payload_digest =
          NEW.broker_backend_capabilities_digest
     WHERE server.collaboration_server_id = NEW.collaboration_server_id
       AND server.machine_identity_id = NEW.machine_identity_id
       AND server.state = 'installing'
       AND server.current_coordinator_lease_id = NEW.coordinator_lease_id
       AND server.current_coordinator_epoch = NEW.coordinator_epoch
       AND lease.state = 'current'
       AND lease.released_at_ms IS NULL
       AND lease.acquired_at_ms <= NEW.created_at_ms
       AND NEW.created_at_ms < lease.heartbeat_deadline_ms
       AND capability_pin.observed_at_ms <= NEW.created_at_ms
       AND (
         NEW.route_kind <> 'chat'
         OR EXISTS (
           SELECT 1 FROM logical_chats AS chat
            WHERE chat.collaboration_server_id = NEW.collaboration_server_id
              AND chat.logical_chat_id = NEW.logical_chat_id
              AND chat.state IN ('recovering', 'ready')
         )
       )
  ) THEN RAISE(ABORT, 'broker route requires its current coordinator and prior capability pin') END;
END`;

const CREATE_BROKER_ROUTES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER broker_routes_no_delete
BEFORE DELETE ON broker_routes
BEGIN
  SELECT RAISE(ABORT, 'broker routes are retained');
END`;

const CREATE_BROKER_ROUTES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER broker_routes_no_replace
BEFORE INSERT ON broker_routes
WHEN EXISTS (
  SELECT 1 FROM broker_routes WHERE broker_route_id = NEW.broker_route_id
)
BEGIN
  SELECT RAISE(ABORT, 'schema-v7 broker routes are immutable');
END`;

const CREATE_BROKER_GENERATIONS_REQUIRE_CHAIN_TRIGGER_SQL = `CREATE TRIGGER broker_channel_generations_require_chain
BEFORE INSERT ON broker_channel_generations
BEGIN
  SELECT CASE
    WHEN NEW.channel_generation = 0 AND NEW.state <> 'open'
      THEN RAISE(ABORT, 'broker genesis generation must be open')
    WHEN NEW.channel_generation > 0 AND NOT EXISTS (
      SELECT 1 FROM broker_channel_generations AS prior
      WHERE prior.broker_route_id = NEW.broker_route_id
        AND prior.channel_generation = NEW.channel_generation - 1
        AND prior.state = 'sealed'
        AND prior.next_generation = NEW.channel_generation
    ) THEN RAISE(ABORT, 'broker generation requires its sealed predecessor')
  END;
END`;

const CREATE_BROKER_GENERATIONS_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_channel_generations_no_update
BEFORE UPDATE ON broker_channel_generations
BEGIN
  SELECT RAISE(ABORT, 'schema-v7 broker generations are immutable');
END`;

const CREATE_BROKER_GENERATIONS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER broker_channel_generations_no_delete
BEFORE DELETE ON broker_channel_generations
BEGIN
  SELECT RAISE(ABORT, 'broker generations are retained');
END`;

const CREATE_BROKER_GENERATIONS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER broker_channel_generations_no_replace
BEFORE INSERT ON broker_channel_generations
WHEN EXISTS (
  SELECT 1 FROM broker_channel_generations
  WHERE broker_route_id = NEW.broker_route_id
    AND channel_generation = NEW.channel_generation
)
BEGIN
  SELECT RAISE(ABORT, 'schema-v7 broker generations are immutable');
END`;

export const VERSION_SEVEN_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] =
  Object.freeze([
    schemaEntry(
      "table",
      "broker_backend_capability_pins",
      "broker_backend_capability_pins",
      CREATE_BROKER_BACKEND_CAPABILITY_PINS_SQL,
    ),
    schemaEntry("table", "broker_routes", "broker_routes", CREATE_BROKER_ROUTES_SQL),
    schemaEntry(
      "table",
      "broker_channel_generations",
      "broker_channel_generations",
      CREATE_BROKER_CHANNEL_GENERATIONS_SQL,
    ),
    schemaEntry(
      "index",
      "broker_backend_capability_pins_coordinate_unique",
      "broker_backend_capability_pins",
      CREATE_CAPABILITY_PINS_COORDINATE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_backend_capability_pins_route_reference_unique",
      "broker_backend_capability_pins",
      CREATE_CAPABILITY_PINS_ROUTE_REFERENCE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_routes_non_chat_scope_unique",
      "broker_routes",
      CREATE_BROKER_ROUTES_NON_CHAT_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_routes_chat_scope_unique",
      "broker_routes",
      CREATE_BROKER_ROUTES_CHAT_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_routes_token_unique",
      "broker_routes",
      CREATE_BROKER_ROUTES_TOKEN_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_routes_store_instance_unique",
      "broker_routes",
      CREATE_BROKER_ROUTES_STORE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_channel_generations_one_open_unique",
      "broker_channel_generations",
      CREATE_BROKER_GENERATIONS_OPEN_INDEX_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_backend_capability_pins_require_exact_artifact",
      "broker_backend_capability_pins",
      CREATE_CAPABILITY_PINS_REQUIRE_ARTIFACT_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_backend_capability_pins_no_update",
      "broker_backend_capability_pins",
      CREATE_CAPABILITY_PINS_NO_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_backend_capability_pins_no_delete",
      "broker_backend_capability_pins",
      CREATE_CAPABILITY_PINS_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_backend_capability_pins_no_replace",
      "broker_backend_capability_pins",
      CREATE_CAPABILITY_PINS_NO_REPLACE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_routes_no_update",
      "broker_routes",
      CREATE_BROKER_ROUTES_NO_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_routes_require_current_authority",
      "broker_routes",
      CREATE_BROKER_ROUTES_REQUIRE_CURRENT_AUTHORITY_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_routes_no_delete",
      "broker_routes",
      CREATE_BROKER_ROUTES_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_routes_no_replace",
      "broker_routes",
      CREATE_BROKER_ROUTES_NO_REPLACE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_channel_generations_require_chain",
      "broker_channel_generations",
      CREATE_BROKER_GENERATIONS_REQUIRE_CHAIN_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_channel_generations_no_update",
      "broker_channel_generations",
      CREATE_BROKER_GENERATIONS_NO_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_channel_generations_no_delete",
      "broker_channel_generations",
      CREATE_BROKER_GENERATIONS_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_channel_generations_no_replace",
      "broker_channel_generations",
      CREATE_BROKER_GENERATIONS_NO_REPLACE_TRIGGER_SQL,
    ),
  ]);
