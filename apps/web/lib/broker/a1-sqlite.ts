import { type Client, createClient, type ResultSet, type Transaction } from "@libsql/client";
import {
  A1BrokerContractError,
  type A1EncryptedFrameV2,
  A1WireError,
  a1BrokerGenerationManifestDigest,
  assertA1FrameMatchesRoute,
  base64urlEncode,
  encodeA1EncryptedFrameV2,
  parseA1BrokerCanonicalFrameV1,
} from "@remote-claw/clawsec";
import {
  A1_BROKER_CAPABILITIES_DIGEST,
  A1_MAX_ROUTES_PER_IDENTITY,
  A1_ROUTE_FRAME_CAP,
  A1_SUBSCRIBE_FRAME_BYTES_CAP,
  A1BrokerError,
  type A1GenerationDescriptor,
  type A1OpenRouteResult,
  type A1ReadPositionV1,
  type A1RelayInput,
  type A1RelayResult,
  type A1RouteCoordinates,
  type A1SubscribeResult,
} from "./a1-contract";
import type { DbLocator } from "./sqlite-multi";
import { selectLocatorFromEnv } from "./turso-cloud-locator";

type ClientFactory = typeof createClient;
type SqlRow = ResultSet["rows"][number];

// This token is deliberately outside every A0 and canonical A1 route namespace. It gives A1 its own
// locator-backed catalog database, so the A0 `sessions` retention index never enumerates or drops A1
// route continuity state.
const A1_CATALOG_TOKEN = "__remote-claw-a1-route-catalog-v1__";
const A1_STORE_INSTANCE_ID_ATTEMPTS = 16;

const CATALOG_DDL = [
  `CREATE TABLE IF NOT EXISTS a1_route_catalog (
     broker_route_id         TEXT PRIMARY KEY,
     identity_id             TEXT NOT NULL,
     collaboration_server_id TEXT NOT NULL,
     route_kind              TEXT NOT NULL CHECK (route_kind IN ('scope_bus','server_control','chat')),
     logical_chat_id         TEXT,
     route_token             TEXT NOT NULL UNIQUE,
     store_instance_id       TEXT NOT NULL,
     capabilities_digest     TEXT NOT NULL,
     state                   TEXT NOT NULL CHECK (state IN ('provisioning','current','lost')),
     created_at              INTEGER NOT NULL,
     updated_at              INTEGER NOT NULL,
     CHECK ((route_kind = 'chat' AND logical_chat_id IS NOT NULL) OR
            (route_kind != 'chat' AND logical_chat_id IS NULL))
   )`,
  `CREATE INDEX IF NOT EXISTS a1_route_catalog_identity
     ON a1_route_catalog (identity_id, broker_route_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS a1_route_catalog_store_instance
     ON a1_route_catalog (store_instance_id)`,
];

const ROUTE_DDL = [
  `CREATE TABLE IF NOT EXISTS a1_route (
     singleton               INTEGER PRIMARY KEY CHECK (singleton = 1),
     broker_route_id         TEXT NOT NULL UNIQUE,
     identity_id             TEXT NOT NULL,
     collaboration_server_id TEXT NOT NULL,
     route_kind              TEXT NOT NULL CHECK (route_kind IN ('scope_bus','server_control','chat')),
     logical_chat_id         TEXT,
     route_token             TEXT NOT NULL UNIQUE,
     store_instance_id       TEXT NOT NULL UNIQUE,
     capabilities_digest     TEXT NOT NULL,
     genesis_generation      INTEGER NOT NULL CHECK (genesis_generation = 0),
     current_generation      INTEGER NOT NULL CHECK (current_generation >= 0),
     created_at              INTEGER NOT NULL,
     CHECK ((route_kind = 'chat' AND logical_chat_id IS NOT NULL) OR
            (route_kind != 'chat' AND logical_chat_id IS NULL))
   )`,
  `CREATE TABLE IF NOT EXISTS a1_generations (
     channel_generation INTEGER PRIMARY KEY CHECK (channel_generation >= 0),
     state              TEXT NOT NULL CHECK (state IN ('open','sealed')),
     frame_count        INTEGER,
     next_generation    INTEGER UNIQUE,
     manifest_digest    TEXT UNIQUE,
     next_frame_index   INTEGER NOT NULL CHECK (next_frame_index >= 0),
     created_at         INTEGER NOT NULL,
     sealed_at          INTEGER,
     CHECK ((state = 'open' AND frame_count IS NULL AND next_generation IS NULL AND
             manifest_digest IS NULL AND sealed_at IS NULL) OR
            (state = 'sealed' AND frame_count IS NOT NULL AND frame_count >= 0 AND
             next_generation = channel_generation + 1 AND manifest_digest IS NOT NULL AND
             sealed_at IS NOT NULL)),
     CHECK (state = 'open' OR next_frame_index = frame_count)
   )`,
  `CREATE TABLE IF NOT EXISTS a1_frames (
     channel_generation INTEGER NOT NULL,
     frame_index         INTEGER NOT NULL CHECK (frame_index >= 0),
     delivery_attempt_id TEXT NOT NULL,
     part                INTEGER NOT NULL CHECK (part >= 0),
     transport_digest    TEXT NOT NULL,
     frame               TEXT NOT NULL,
     created_at          INTEGER NOT NULL,
     PRIMARY KEY (channel_generation, frame_index),
     FOREIGN KEY (channel_generation) REFERENCES a1_generations(channel_generation)
   )`,
  `CREATE TABLE IF NOT EXISTS a1_attempt_parts (
     delivery_attempt_id TEXT NOT NULL,
     part                INTEGER NOT NULL CHECK (part >= 0),
     channel_generation  INTEGER NOT NULL,
     frame_index         INTEGER NOT NULL,
     transport_digest    TEXT NOT NULL,
     created_at          INTEGER NOT NULL,
     PRIMARY KEY (delivery_attempt_id, part),
     UNIQUE (channel_generation, frame_index),
     FOREIGN KEY (channel_generation, frame_index)
       REFERENCES a1_frames(channel_generation, frame_index)
   )`,
  `CREATE TABLE IF NOT EXISTS a1_transport_collisions (
     delivery_attempt_id              TEXT NOT NULL,
     part                             INTEGER NOT NULL CHECK (part >= 0),
     original_transport_digest        TEXT NOT NULL,
     first_conflicting_transport_digest TEXT NOT NULL,
     first_observed_at                INTEGER NOT NULL,
     PRIMARY KEY (delivery_attempt_id, part),
     FOREIGN KEY (delivery_attempt_id, part)
       REFERENCES a1_attempt_parts(delivery_attempt_id, part)
   )`,
  `CREATE INDEX IF NOT EXISTS a1_frames_generation_index
     ON a1_frames (channel_generation, frame_index)`,
];

interface CatalogRow {
  readonly brokerRouteId: string;
  readonly identityIdHex: string;
  readonly collaborationServerId: string;
  readonly routeKind: string;
  readonly logicalChatId: string | null;
  readonly routeToken: string;
  readonly storeInstanceId: string;
  readonly capabilitiesDigest: string;
  readonly state: "provisioning" | "current" | "lost";
}

interface OpenClient {
  readonly client: Client;
  readonly url: string;
}

type GlobalWithA1Locks = typeof globalThis & {
  __remoteClawA1WriteLocks?: Map<string, Promise<void>>;
};

const globals = globalThis as GlobalWithA1Locks;
if (globals.__remoteClawA1WriteLocks === undefined) {
  globals.__remoteClawA1WriteLocks = new Map();
}
const writeLocks = globals.__remoteClawA1WriteLocks;

function fail(code: ConstructorParameters<typeof A1BrokerError>[0], status: number): never {
  throw new A1BrokerError(code, status);
}

function safeUint(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || Object.is(number, -0)) {
    return fail("broker_failure", 500);
  }
  return number;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") return fail("broker_failure", 500);
  return value;
}

function isMissingStoreError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  let current: unknown = error;
  const seen = new Set<unknown>();
  let status: number | undefined;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = (current as { status?: unknown }).status;
    if (typeof candidate === "number") {
      status = candidate;
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return (
    status === 404 ||
    /was deleted while processing/i.test(message) ||
    /no such table:\s*a1_/i.test(message) ||
    (/\bnamespace\b/i.test(message) &&
      /(doesn't exist|does not exist|not found|was deleted)/i.test(message))
  );
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return /SQLITE_BUSY|SQLITE_LOCKED/.test(`${code} ${message}`);
}

async function withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  writeLocks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === current) writeLocks.delete(key);
  }
}

async function writeTransaction<T>(
  client: Client,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await client.transaction("write");
  let settled = false;
  try {
    const result = await fn(tx);
    await tx.commit();
    settled = true;
    return result;
  } catch (error) {
    if (!settled) {
      try {
        await tx.rollback();
      } catch {
        // A failed commit may already have settled the transaction.
      }
    }
    throw error;
  } finally {
    tx.close();
  }
}

async function manifestDigest(
  brokerRouteId: string,
  generation: number,
  frameCount: number,
): Promise<string> {
  return a1BrokerGenerationManifestDigest({
    brokerRouteId,
    channelGeneration: generation,
    frameCount,
    nextGeneration: generation + 1,
    state: "sealed",
  });
}

function randomStoreInstanceId(randomBytes: (byteLength: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    return fail("broker_failure", 500);
  }
  return `rbsi_${base64urlEncode(bytes)}`;
}

function catalogRow(row: SqlRow): CatalogRow {
  const state = rowText(row, "state");
  if (state !== "provisioning" && state !== "current" && state !== "lost") {
    return fail("broker_failure", 500);
  }
  return {
    brokerRouteId: rowText(row, "broker_route_id"),
    identityIdHex: rowText(row, "identity_id"),
    collaborationServerId: rowText(row, "collaboration_server_id"),
    routeKind: rowText(row, "route_kind"),
    logicalChatId: nullableText(row.logical_chat_id),
    routeToken: rowText(row, "route_token"),
    storeInstanceId: rowText(row, "store_instance_id"),
    capabilitiesDigest: rowText(row, "capabilities_digest"),
    state,
  };
}

function generationDescriptor(row: SqlRow): A1GenerationDescriptor {
  const channelGeneration = safeUint(row.channel_generation);
  const nextFrameIndex = safeUint(row.next_frame_index);
  const state = rowText(row, "state");
  if (state === "open") {
    if (row.frame_count !== null || row.next_generation !== null || row.manifest_digest !== null) {
      return fail("broker_failure", 500);
    }
    return {
      channel_generation: channelGeneration,
      state: "open",
      frame_count: null,
      next_generation: null,
      manifest_digest: null,
      next_frame_index: nextFrameIndex,
    };
  }
  if (state !== "sealed") return fail("broker_failure", 500);
  const frameCount = safeUint(row.frame_count);
  const nextGeneration = safeUint(row.next_generation);
  const digest = rowText(row, "manifest_digest");
  if (
    nextFrameIndex !== frameCount ||
    nextGeneration !== channelGeneration + 1 ||
    digest.length !== 43
  ) {
    return fail("broker_failure", 500);
  }
  return {
    channel_generation: channelGeneration,
    state: "sealed",
    frame_count: frameCount,
    next_generation: nextGeneration,
    manifest_digest: digest,
    next_frame_index: nextFrameIndex,
  };
}

function sameRoute(row: CatalogRow, route: A1RouteCoordinates): boolean {
  return (
    row.brokerRouteId === route.brokerRouteId &&
    row.identityIdHex === route.identityIdHex &&
    row.collaborationServerId === route.collaborationServerId &&
    row.routeKind === route.routeKind &&
    row.logicalChatId === route.logicalChatId &&
    row.routeToken === route.routeToken
  );
}

/** Durable selected-A1 broker. It deliberately does not implement the A0 BrokerBackend interface: an
 * A0 selector can never accidentally advertise or reach these stronger semantics. */
export class A1SqliteBackend {
  readonly #locator: DbLocator;
  readonly #newClient: ClientFactory;
  readonly #randomBytes: (byteLength: number) => Uint8Array;

  constructor(
    locator: DbLocator = selectLocatorFromEnv(),
    newClient: ClientFactory = createClient,
    randomBytes: (byteLength: number) => Uint8Array = (byteLength) => {
      const bytes = new Uint8Array(byteLength);
      crypto.getRandomValues(bytes);
      return bytes;
    },
  ) {
    this.#locator = locator;
    this.#newClient = newClient;
    this.#randomBytes = randomBytes;
  }

  async #openClient(token: string, create: boolean, ready: boolean): Promise<OpenClient | null> {
    if (create) {
      await this.#locator.ensure(token);
    } else if (!(await this.#locator.exists(token))) {
      return null;
    }
    const config = this.#locator.config(token);
    const client = this.#newClient(config);
    try {
      if (ready) await this.#locator.awaitReady?.(client, token);
      await this.#locator.prepare?.(client);
      await client.execute("PRAGMA foreign_keys = ON");
      return { client, url: config.url };
    } catch (error) {
      try {
        client.close();
      } catch {
        // already closed
      }
      if (!create && isMissingStoreError(error)) {
        this.#locator.forget?.(token);
        return null;
      }
      throw error;
    }
  }

  async #catalog(): Promise<OpenClient> {
    const opened = await this.#openClient(A1_CATALOG_TOKEN, true, true);
    if (opened === null) return fail("broker_failure", 500);
    try {
      await withWriteLock(opened.url, async () => {
        await opened.client.batch(CATALOG_DDL, "write");
      });
      return opened;
    } catch (error) {
      opened.client.close();
      throw error;
    }
  }

  async #lookupCatalog(route: A1RouteCoordinates): Promise<CatalogRow | null> {
    const opened = await this.#catalog();
    try {
      const result = await opened.client.execute({
        sql: `SELECT * FROM a1_route_catalog
              WHERE broker_route_id = ? OR route_token = ?`,
        args: [route.brokerRouteId, route.routeToken],
      });
      if (result.rows.length > 1) return fail("route_coordinate_collision", 409);
      const row = result.rows[0];
      if (row === undefined) return null;
      const parsed = catalogRow(row);
      if (!sameRoute(parsed, route)) return fail("route_coordinate_collision", 409);
      if (parsed.capabilitiesDigest !== A1_BROKER_CAPABILITIES_DIGEST) {
        return fail("broker_capabilities_mismatch", 409);
      }
      return parsed;
    } finally {
      opened.client.close();
    }
  }

  async #reserveCatalog(route: A1RouteCoordinates): Promise<CatalogRow> {
    const opened = await this.#catalog();
    try {
      return await withWriteLock(opened.url, () =>
        writeTransaction(opened.client, async (tx) => {
          const found = await tx.execute({
            sql: `SELECT * FROM a1_route_catalog
                  WHERE broker_route_id = ? OR route_token = ?`,
            args: [route.brokerRouteId, route.routeToken],
          });
          const existingRow = found.rows[0];
          if (found.rows.length > 1) return fail("route_coordinate_collision", 409);
          if (existingRow !== undefined) {
            const existing = catalogRow(existingRow);
            if (!sameRoute(existing, route)) return fail("route_coordinate_collision", 409);
            return existing;
          }
          const count = await tx.execute({
            sql: "SELECT COUNT(*) AS n FROM a1_route_catalog WHERE identity_id = ?",
            args: [route.identityIdHex],
          });
          if (safeUint(count.rows[0]?.n) >= A1_MAX_ROUTES_PER_IDENTITY) {
            return fail("counter_exhausted", 507);
          }
          let proposedStoreId: string | undefined;
          for (let attempt = 0; attempt < A1_STORE_INSTANCE_ID_ATTEMPTS; attempt++) {
            const candidate = randomStoreInstanceId(this.#randomBytes);
            const collision = await tx.execute({
              sql: "SELECT 1 FROM a1_route_catalog WHERE store_instance_id = ? LIMIT 1",
              args: [candidate],
            });
            if (collision.rows[0] === undefined) {
              proposedStoreId = candidate;
              break;
            }
          }
          if (proposedStoreId === undefined) return fail("counter_exhausted", 507);
          const now = Date.now();
          await tx.execute({
            sql: `INSERT INTO a1_route_catalog
                    (broker_route_id, identity_id, collaboration_server_id, route_kind,
                     logical_chat_id, route_token, store_instance_id, capabilities_digest,
                     state, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?)
                  `,
            args: [
              route.brokerRouteId,
              route.identityIdHex,
              route.collaborationServerId,
              route.routeKind,
              route.logicalChatId,
              route.routeToken,
              proposedStoreId,
              A1_BROKER_CAPABILITIES_DIGEST,
              now,
              now,
            ],
          });
          const inserted = await tx.execute({
            sql: `SELECT * FROM a1_route_catalog
                  WHERE broker_route_id = ? OR route_token = ?`,
            args: [route.brokerRouteId, route.routeToken],
          });
          if (inserted.rows.length > 1) return fail("route_coordinate_collision", 409);
          const row = inserted.rows[0];
          if (row === undefined) return fail("broker_failure", 500);
          const parsed = catalogRow(row);
          if (!sameRoute(parsed, route)) return fail("route_coordinate_collision", 409);
          return parsed;
        }),
      );
    } finally {
      opened.client.close();
    }
  }

  async #installRecoveredCatalog(
    route: A1RouteCoordinates,
    storeInstanceId: string,
  ): Promise<void> {
    const opened = await this.#catalog();
    try {
      await withWriteLock(opened.url, () =>
        writeTransaction(opened.client, async (tx) => {
          const found = await tx.execute({
            sql: `SELECT * FROM a1_route_catalog
                  WHERE broker_route_id = ? OR route_token = ?`,
            args: [route.brokerRouteId, route.routeToken],
          });
          const row = found.rows[0];
          if (found.rows.length > 1) return fail("route_coordinate_collision", 409);
          if (row !== undefined) {
            const parsed = catalogRow(row);
            if (!sameRoute(parsed, route)) return fail("route_coordinate_collision", 409);
            if (parsed.storeInstanceId !== storeInstanceId) {
              return fail("route_store_mismatch", 409);
            }
            if (parsed.capabilitiesDigest !== A1_BROKER_CAPABILITIES_DIGEST) {
              return fail("broker_capabilities_mismatch", 409);
            }
            if (parsed.state === "lost") return fail("route_not_found", 404);
            await tx.execute({
              sql: `UPDATE a1_route_catalog SET state = 'current', updated_at = ?
                    WHERE broker_route_id = ? AND store_instance_id = ?
                      AND state = 'provisioning'`,
              args: [Date.now(), route.brokerRouteId, storeInstanceId],
            });
          } else {
            const count = await tx.execute({
              sql: "SELECT COUNT(*) AS n FROM a1_route_catalog WHERE identity_id = ?",
              args: [route.identityIdHex],
            });
            if (safeUint(count.rows[0]?.n) >= A1_MAX_ROUTES_PER_IDENTITY) {
              return fail("counter_exhausted", 507);
            }
            const now = Date.now();
            await tx.execute({
              sql: `INSERT INTO a1_route_catalog
                      (broker_route_id, identity_id, collaboration_server_id, route_kind,
                       logical_chat_id, route_token, store_instance_id, capabilities_digest,
                       state, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
              args: [
                route.brokerRouteId,
                route.identityIdHex,
                route.collaborationServerId,
                route.routeKind,
                route.logicalChatId,
                route.routeToken,
                storeInstanceId,
                A1_BROKER_CAPABILITIES_DIGEST,
                now,
                now,
              ],
            });
          }
        }),
      );
    } finally {
      opened.client.close();
    }
  }

  async #setCatalogState(
    route: A1RouteCoordinates,
    storeInstanceId: string,
    state: "current" | "lost",
  ): Promise<void> {
    const opened = await this.#catalog();
    try {
      await withWriteLock(opened.url, async () => {
        await opened.client.execute({
          sql: `UPDATE a1_route_catalog SET state = ?, updated_at = ?
                WHERE broker_route_id = ? AND store_instance_id = ?
                  AND state != 'lost'`,
          args: [state, Date.now(), route.brokerRouteId, storeInstanceId],
        });
      });
    } finally {
      opened.client.close();
    }
  }

  #assertCatalogRoute(row: CatalogRow, route: A1RouteCoordinates, expected: string | null): void {
    if (!sameRoute(row, route)) fail("route_coordinate_collision", 409);
    if (row.capabilitiesDigest !== A1_BROKER_CAPABILITIES_DIGEST) {
      fail("broker_capabilities_mismatch", 409);
    }
    if (expected !== null && row.storeInstanceId !== expected) {
      fail("route_store_mismatch", 409);
    }
    if (row.state === "lost") fail("route_not_found", 404);
  }

  #assertPhysicalRoute(
    row: SqlRow,
    route: A1RouteCoordinates,
    expectedStoreInstanceId: string,
  ): string {
    const storeInstanceId = rowText(row, "store_instance_id");
    if (
      rowText(row, "broker_route_id") !== route.brokerRouteId ||
      rowText(row, "identity_id") !== route.identityIdHex ||
      rowText(row, "collaboration_server_id") !== route.collaborationServerId ||
      rowText(row, "route_kind") !== route.routeKind ||
      nullableText(row.logical_chat_id) !== route.logicalChatId ||
      rowText(row, "route_token") !== route.routeToken
    ) {
      return fail("route_coordinate_collision", 409);
    }
    if (storeInstanceId !== expectedStoreInstanceId) return fail("route_store_mismatch", 409);
    if (rowText(row, "capabilities_digest") !== A1_BROKER_CAPABILITIES_DIGEST) {
      return fail("broker_capabilities_mismatch", 409);
    }
    if (safeUint(row.genesis_generation) !== 0) return fail("broker_failure", 500);
    return storeInstanceId;
  }

  async #readPhysical(
    route: A1RouteCoordinates,
    expectedStoreInstanceId: string | null,
  ): Promise<{
    storeInstanceId: string;
    genesis: A1GenerationDescriptor;
    generation: A1GenerationDescriptor;
  } | null> {
    const opened = await this.#openClient(route.routeToken, false, false);
    if (opened === null) return null;
    try {
      const tx = await opened.client.transaction("read");
      try {
        const result = await tx.execute(
          `SELECT r.*, g.state, g.frame_count, g.next_generation, g.manifest_digest,
                  g.next_frame_index, g.channel_generation
             FROM a1_route r
             JOIN a1_generations g ON g.channel_generation = r.current_generation
            WHERE r.singleton = 1`,
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        const actual = rowText(row, "store_instance_id");
        const expected = expectedStoreInstanceId ?? actual;
        this.#assertPhysicalRoute(row, route, expected);
        const generation = generationDescriptor(row);
        if (generation.state !== "open") return fail("broker_failure", 500);
        const genesisResult = await tx.execute(
          "SELECT * FROM a1_generations WHERE channel_generation = 0",
        );
        const genesisRow = genesisResult.rows[0];
        if (genesisRow === undefined) return fail("broker_failure", 500);
        return {
          storeInstanceId: actual,
          genesis: generationDescriptor(genesisRow),
          generation,
        };
      } finally {
        tx.close();
      }
    } catch (error) {
      if (isMissingStoreError(error)) return null;
      throw error;
    } finally {
      opened.client.close();
    }
  }

  async #provisionPhysical(
    route: A1RouteCoordinates,
    storeInstanceId: string,
  ): Promise<{
    created: boolean;
    genesis: A1GenerationDescriptor;
    generation: A1GenerationDescriptor;
  }> {
    const opened = await this.#openClient(route.routeToken, true, true);
    if (opened === null) return fail("broker_failure", 500);
    try {
      return await withWriteLock(opened.url, async () => {
        await opened.client.batch(ROUTE_DDL, "write");
        return writeTransaction(opened.client, async (tx) => {
          const found = await tx.execute("SELECT * FROM a1_route WHERE singleton = 1");
          const existing = found.rows[0];
          let created = false;
          if (existing === undefined) {
            const now = Date.now();
            await tx.execute({
              sql: `INSERT INTO a1_route
                      (singleton, broker_route_id, identity_id, collaboration_server_id, route_kind,
                       logical_chat_id, route_token, store_instance_id, capabilities_digest,
                       genesis_generation, current_generation, created_at)
                    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
              args: [
                route.brokerRouteId,
                route.identityIdHex,
                route.collaborationServerId,
                route.routeKind,
                route.logicalChatId,
                route.routeToken,
                storeInstanceId,
                A1_BROKER_CAPABILITIES_DIGEST,
                now,
              ],
            });
            await tx.execute({
              sql: `INSERT INTO a1_generations
                      (channel_generation, state, frame_count, next_generation, manifest_digest,
                       next_frame_index, created_at, sealed_at)
                    VALUES (0, 'open', NULL, NULL, NULL, 0, ?, NULL)`,
              args: [now],
            });
            created = true;
          } else {
            this.#assertPhysicalRoute(existing, route, storeInstanceId);
          }
          const generation = await tx.execute(
            `SELECT g.* FROM a1_generations g
              JOIN a1_route r ON r.current_generation = g.channel_generation
             WHERE r.singleton = 1`,
          );
          const row = generation.rows[0];
          if (row === undefined) return fail("broker_failure", 500);
          const current = generationDescriptor(row);
          if (current.state !== "open") return fail("broker_failure", 500);
          const genesisResult = await tx.execute(
            "SELECT * FROM a1_generations WHERE channel_generation = 0",
          );
          const genesisRow = genesisResult.rows[0];
          if (genesisRow === undefined) return fail("broker_failure", 500);
          return { created, genesis: generationDescriptor(genesisRow), generation: current };
        });
      });
    } finally {
      opened.client.close();
    }
  }

  async openRoute(
    route: A1RouteCoordinates,
    expectedRouteStoreInstanceId: string | null,
  ): Promise<A1OpenRouteResult> {
    let catalog = await this.#lookupCatalog(route);
    if (catalog !== null) {
      this.#assertCatalogRoute(catalog, route, expectedRouteStoreInstanceId);
      if (catalog.state === "current") {
        const physical = await this.#readPhysical(route, catalog.storeInstanceId);
        if (physical === null) {
          await this.#setCatalogState(route, catalog.storeInstanceId, "lost");
          return fail("route_not_found", 404);
        }
        return {
          disposition: "existing",
          brokerRouteId: route.brokerRouteId,
          routeStoreInstanceId: catalog.storeInstanceId,
          genesis: physical.genesis,
          generation: physical.generation,
          observedNextFrameIndex: physical.generation.next_frame_index,
        };
      }
    } else {
      // A separately lost catalog can be reconstructed only from an intact route database. With an
      // expected store id, absence is terminal and MUST NOT provision a replacement.
      const physical = await this.#readPhysical(route, expectedRouteStoreInstanceId);
      if (physical !== null) {
        await this.#installRecoveredCatalog(route, physical.storeInstanceId);
        return {
          disposition: "existing",
          brokerRouteId: route.brokerRouteId,
          routeStoreInstanceId: physical.storeInstanceId,
          genesis: physical.genesis,
          generation: physical.generation,
          observedNextFrameIndex: physical.generation.next_frame_index,
        };
      }
      if (expectedRouteStoreInstanceId !== null) return fail("route_not_found", 404);
      catalog = await this.#reserveCatalog(route);
      this.#assertCatalogRoute(catalog, route, null);
    }

    if (catalog === null) return fail("broker_failure", 500);
    const provisioned = await this.#provisionPhysical(route, catalog.storeInstanceId);
    await this.#setCatalogState(route, catalog.storeInstanceId, "current");
    return {
      disposition: provisioned.created ? "created" : "existing",
      brokerRouteId: route.brokerRouteId,
      routeStoreInstanceId: catalog.storeInstanceId,
      genesis: provisioned.genesis,
      generation: provisioned.generation,
      observedNextFrameIndex: provisioned.generation.next_frame_index,
    };
  }

  async #openForUse(
    route: A1RouteCoordinates,
    expectedStoreInstanceId: string,
  ): Promise<OpenClient> {
    const catalog = await this.#lookupCatalog(route);
    if (catalog !== null) {
      this.#assertCatalogRoute(catalog, route, expectedStoreInstanceId);
      if (catalog.state !== "current") return fail("route_not_found", 404);
    }
    const opened = await this.#openClient(route.routeToken, false, false);
    if (opened === null) {
      if (catalog?.state === "current") {
        await this.#setCatalogState(route, expectedStoreInstanceId, "lost");
      }
      return fail("route_not_found", 404);
    }
    try {
      const found = await opened.client.execute("SELECT * FROM a1_route WHERE singleton = 1");
      const row = found.rows[0];
      if (row === undefined) throw new A1BrokerError("route_not_found", 404);
      this.#assertPhysicalRoute(row, route, expectedStoreInstanceId);
      if (catalog === null) await this.#installRecoveredCatalog(route, expectedStoreInstanceId);
      return opened;
    } catch (error) {
      opened.client.close();
      if (
        isMissingStoreError(error) ||
        (A1BrokerError.is(error) && error.code === "route_not_found")
      ) {
        if (catalog?.state === "current") {
          await this.#setCatalogState(route, expectedStoreInstanceId, "lost");
        }
        return fail("route_not_found", 404);
      }
      throw error;
    }
  }

  async relay(input: A1RelayInput): Promise<A1RelayResult> {
    let canonicalFrame: string;
    let transportFrameDigest: string;
    try {
      const inspected = await parseA1BrokerCanonicalFrameV1(encodeA1EncryptedFrameV2(input.frame));
      canonicalFrame = inspected.canonicalFrame;
      transportFrameDigest = inspected.transportFrameDigest;
    } catch (error) {
      if (A1BrokerContractError.is(error)) {
        return fail(
          error.reason === "bad-length" ? "frame_too_large" : "invalid_request",
          error.reason === "bad-length" ? 413 : 400,
        );
      }
      if (A1WireError.is(error)) return fail("invalid_request", 400);
      throw error;
    }
    try {
      assertA1FrameMatchesRoute(input.frame, input.route.route);
    } catch {
      return fail("route_auth_mismatch", 403);
    }
    const opened = await this.#openForUse(input.route, input.expectedRouteStoreInstanceId);
    try {
      return await withWriteLock(opened.url, () =>
        writeTransaction(opened.client, async (tx) => {
          const routeResult = await tx.execute("SELECT * FROM a1_route WHERE singleton = 1");
          const routeRow = routeResult.rows[0];
          if (routeRow === undefined) return fail("route_not_found", 404);
          this.#assertPhysicalRoute(routeRow, input.route, input.expectedRouteStoreInstanceId);

          const attempt = await tx.execute({
            sql: `SELECT channel_generation, frame_index, transport_digest
                    FROM a1_attempt_parts
                   WHERE delivery_attempt_id = ? AND part = ?`,
            args: [input.frame.deliveryAttemptId, input.frame.part],
          });
          const original = attempt.rows[0];
          if (original !== undefined) {
            const originalDigest = rowText(original, "transport_digest");
            const originalCursor = {
              version: 1,
              channel_generation: safeUint(original.channel_generation),
              frame_index: safeUint(original.frame_index),
            } as const;
            if (originalDigest === transportFrameDigest) {
              return {
                kind: "stored",
                disposition: "exact_retry",
                brokerRouteId: input.route.brokerRouteId,
                routeStoreInstanceId: input.expectedRouteStoreInstanceId,
                cursor: originalCursor,
                transportFrameDigest: originalDigest,
              } as const;
            }
            await tx.execute({
              sql: `INSERT OR IGNORE INTO a1_transport_collisions
                      (delivery_attempt_id, part, original_transport_digest,
                       first_conflicting_transport_digest, first_observed_at)
                    VALUES (?, ?, ?, ?, ?)`,
              args: [
                input.frame.deliveryAttemptId,
                input.frame.part,
                originalDigest,
                transportFrameDigest,
                Date.now(),
              ],
            });
            const collision = await tx.execute({
              sql: `SELECT first_conflicting_transport_digest
                      FROM a1_transport_collisions
                     WHERE delivery_attempt_id = ? AND part = ?`,
              args: [input.frame.deliveryAttemptId, input.frame.part],
            });
            const collisionRow = collision.rows[0];
            if (collisionRow === undefined) return fail("broker_failure", 500);
            return {
              kind: "collision",
              brokerRouteId: input.route.brokerRouteId,
              routeStoreInstanceId: input.expectedRouteStoreInstanceId,
              deliveryAttemptId: input.frame.deliveryAttemptId,
              part: input.frame.part,
              originalCursor,
              originalTransportFrameDigest: originalDigest,
              firstConflictingTransportFrameDigest: rowText(
                collisionRow,
                "first_conflicting_transport_digest",
              ),
              conflictingTransportFrameDigest: transportFrameDigest,
            } as const;
          }

          const current = safeUint(routeRow.current_generation);
          const generationResult = await tx.execute({
            sql: "SELECT * FROM a1_generations WHERE channel_generation = ?",
            args: [current],
          });
          let generationRow = generationResult.rows[0];
          if (generationRow === undefined) return fail("broker_failure", 500);
          let descriptor = generationDescriptor(generationRow);
          if (descriptor.state !== "open") return fail("broker_failure", 500);

          if (descriptor.next_frame_index >= A1_ROUTE_FRAME_CAP) {
            if (current >= Number.MAX_SAFE_INTEGER) return fail("counter_exhausted", 507);
            const digest = await manifestDigest(
              input.route.brokerRouteId,
              current,
              descriptor.next_frame_index,
            );
            const now = Date.now();
            await tx.execute({
              sql: `UPDATE a1_generations
                       SET state = 'sealed', frame_count = ?, next_generation = ?,
                           manifest_digest = ?, sealed_at = ?
                     WHERE channel_generation = ? AND state = 'open'
                       AND next_frame_index = ?`,
              args: [
                descriptor.next_frame_index,
                current + 1,
                digest,
                now,
                current,
                descriptor.next_frame_index,
              ],
            });
            await tx.execute({
              sql: `INSERT INTO a1_generations
                      (channel_generation, state, frame_count, next_generation, manifest_digest,
                       next_frame_index, created_at, sealed_at)
                    VALUES (?, 'open', NULL, NULL, NULL, 0, ?, NULL)`,
              args: [current + 1, now],
            });
            await tx.execute({
              sql: "UPDATE a1_route SET current_generation = ? WHERE singleton = 1",
              args: [current + 1],
            });
            generationRow = (
              await tx.execute({
                sql: "SELECT * FROM a1_generations WHERE channel_generation = ?",
                args: [current + 1],
              })
            ).rows[0];
            if (generationRow === undefined) return fail("broker_failure", 500);
            descriptor = generationDescriptor(generationRow);
          }

          if (descriptor.state !== "open") return fail("broker_failure", 500);
          const generation = descriptor.channel_generation;
          const frameIndex = descriptor.next_frame_index;
          const now = Date.now();
          await tx.execute({
            sql: `INSERT INTO a1_frames
                    (channel_generation, frame_index, delivery_attempt_id, part,
                     transport_digest, frame, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
              generation,
              frameIndex,
              input.frame.deliveryAttemptId,
              input.frame.part,
              transportFrameDigest,
              canonicalFrame,
              now,
            ],
          });
          await tx.execute({
            sql: `INSERT INTO a1_attempt_parts
                    (delivery_attempt_id, part, channel_generation, frame_index,
                     transport_digest, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [
              input.frame.deliveryAttemptId,
              input.frame.part,
              generation,
              frameIndex,
              transportFrameDigest,
              now,
            ],
          });
          const advanced = await tx.execute({
            sql: `UPDATE a1_generations SET next_frame_index = next_frame_index + 1
                   WHERE channel_generation = ? AND state = 'open' AND next_frame_index = ?`,
            args: [generation, frameIndex],
          });
          if (advanced.rowsAffected !== 1) return fail("broker_failure", 500);
          return {
            kind: "stored",
            disposition: "inserted",
            brokerRouteId: input.route.brokerRouteId,
            routeStoreInstanceId: input.expectedRouteStoreInstanceId,
            cursor: {
              version: 1,
              channel_generation: generation,
              frame_index: frameIndex,
            },
            transportFrameDigest,
          } as const;
        }),
      );
    } catch (error) {
      if (isBusyError(error)) return fail("broker_failure", 500);
      if (isMissingStoreError(error)) {
        await this.#setCatalogState(input.route, input.expectedRouteStoreInstanceId, "lost");
        return fail("route_not_found", 404);
      }
      throw error;
    } finally {
      opened.client.close();
    }
  }

  async subscribe(
    route: A1RouteCoordinates,
    expectedStoreInstanceId: string,
    position: A1ReadPositionV1,
    maxFrames: number,
  ): Promise<A1SubscribeResult> {
    if (
      !Number.isSafeInteger(position.channel_generation) ||
      position.channel_generation < 0 ||
      !Number.isSafeInteger(position.next_frame_index) ||
      position.next_frame_index < 0 ||
      position.next_frame_index > A1_ROUTE_FRAME_CAP
    ) {
      return fail("invalid_read_position", 416);
    }
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 64) {
      return fail("invalid_request", 400);
    }
    const opened = await this.#openForUse(route, expectedStoreInstanceId);
    try {
      const tx = await opened.client.transaction("read");
      try {
        const routeResult = await tx.execute("SELECT * FROM a1_route WHERE singleton = 1");
        const routeRow = routeResult.rows[0];
        if (routeRow === undefined) return fail("route_not_found", 404);
        this.#assertPhysicalRoute(routeRow, route, expectedStoreInstanceId);
        const generationResult = await tx.execute({
          sql: "SELECT * FROM a1_generations WHERE channel_generation = ?",
          args: [position.channel_generation],
        });
        const generationRow = generationResult.rows[0];
        if (generationRow === undefined) return fail("invalid_read_position", 416);
        const generation = generationDescriptor(generationRow);
        if (position.next_frame_index > generation.next_frame_index) {
          return fail("invalid_read_position", 416);
        }
        if (generation.state === "sealed") {
          const successor = await tx.execute({
            sql: "SELECT 1 FROM a1_generations WHERE channel_generation = ?",
            args: [generation.next_generation],
          });
          if (successor.rows[0] === undefined) return fail("broker_failure", 500);
        }

        const frames: Array<A1SubscribeResult["frames"][number]> = [];
        const buildPage = (): A1SubscribeResult => {
          const nextFrameIndex =
            frames.length === 0
              ? position.next_frame_index
              : (frames.at(-1)?.cursor.frame_index ?? position.next_frame_index - 1) + 1;
          const nextPosition: A1ReadPositionV1 =
            generation.state === "sealed" && nextFrameIndex === generation.frame_count
              ? {
                  version: 1,
                  channel_generation: generation.next_generation,
                  next_frame_index: 0,
                }
              : {
                  version: 1,
                  channel_generation: position.channel_generation,
                  next_frame_index: nextFrameIndex,
                };
          return {
            brokerRouteId: route.brokerRouteId,
            routeStoreInstanceId: expectedStoreInstanceId,
            generation,
            frames,
            nextPosition,
            observedNextFrameIndex: generation.next_frame_index,
            atLiveTail:
              generation.state === "open" && nextFrameIndex === generation.next_frame_index,
          };
        };
        // Budget the exact snake-case HTTP representation. Each potentially multi-megabyte frame is
        // encoded once; only the small metadata shell is re-encoded as its tail cursor changes.
        const encodedBytes = (page: A1SubscribeResult, encodedFrameBytes: number): number => {
          const shellBytes = new TextEncoder().encode(
            JSON.stringify({
              v: 1,
              broker_route_id: page.brokerRouteId,
              route_store_instance_id: page.routeStoreInstanceId,
              generation: {
                channel_generation: page.generation.channel_generation,
                state: page.generation.state,
                frame_count: page.generation.frame_count,
                next_generation: page.generation.next_generation,
                manifest_digest: page.generation.manifest_digest,
              },
              frames: [],
              next_position: page.nextPosition,
              observed_next_frame_index: page.observedNextFrameIndex,
              at_live_tail: page.atLiveTail,
            }),
          ).byteLength;
          return shellBytes + encodedFrameBytes + Math.max(0, page.frames.length - 1);
        };

        let nextFrameIndex = position.next_frame_index;
        let encodedFrameBytes = 0;
        while (frames.length < maxFrames && nextFrameIndex < generation.next_frame_index) {
          const result = await tx.execute({
            sql: `SELECT frame_index, delivery_attempt_id, part, transport_digest, frame
                    FROM a1_frames
                   WHERE channel_generation = ? AND frame_index = ?`,
            args: [position.channel_generation, nextFrameIndex],
          });
          const row = result.rows[0];
          if (row === undefined) return fail("broker_failure", 500);
          const frameIndex = safeUint(row.frame_index);
          if (frameIndex !== nextFrameIndex) return fail("broker_failure", 500);
          const frame = {
            cursor: {
              version: 1,
              channel_generation: position.channel_generation,
              frame_index: frameIndex,
            },
            delivery_attempt_id: rowText(row, "delivery_attempt_id"),
            part: safeUint(row.part),
            transport_frame_digest: rowText(row, "transport_digest"),
            frame: rowText(row, "frame"),
          } as const;
          const candidateFrameBytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
          frames.push(frame);
          if (
            encodedBytes(buildPage(), encodedFrameBytes + candidateFrameBytes) >
            A1_SUBSCRIBE_FRAME_BYTES_CAP
          ) {
            frames.pop();
            if (frames.length === 0) return fail("broker_failure", 500);
            break;
          }
          encodedFrameBytes += candidateFrameBytes;
          nextFrameIndex++;
        }
        const page = buildPage();
        if (encodedBytes(page, encodedFrameBytes) > A1_SUBSCRIBE_FRAME_BYTES_CAP) {
          return fail("broker_failure", 500);
        }
        return page;
      } finally {
        tx.close();
      }
    } catch (error) {
      if (isMissingStoreError(error)) {
        await this.#setCatalogState(route, expectedStoreInstanceId, "lost");
        return fail("route_not_found", 404);
      }
      throw error;
    } finally {
      opened.client.close();
    }
  }

  /** Internal-only rollover hook for conformance and empty-generation testing. There is intentionally
   * no HTTP route for this operation. */
  async seal(
    route: A1RouteCoordinates,
    expectedStoreInstanceId: string,
    expectedGeneration: number,
  ): Promise<{ sealed: A1GenerationDescriptor; successor: A1GenerationDescriptor }> {
    const opened = await this.#openForUse(route, expectedStoreInstanceId);
    try {
      return await withWriteLock(opened.url, () =>
        writeTransaction(opened.client, async (tx) => {
          const routeResult = await tx.execute("SELECT * FROM a1_route WHERE singleton = 1");
          const routeRow = routeResult.rows[0];
          if (routeRow === undefined) return fail("route_not_found", 404);
          this.#assertPhysicalRoute(routeRow, route, expectedStoreInstanceId);
          const current = safeUint(routeRow.current_generation);
          const generationResult = await tx.execute({
            sql: "SELECT * FROM a1_generations WHERE channel_generation = ?",
            args: [expectedGeneration],
          });
          const generationRow = generationResult.rows[0];
          if (generationRow === undefined) return fail("generation_mismatch", 409);
          const generation = generationDescriptor(generationRow);
          if (generation.state === "sealed") {
            if (current <= expectedGeneration) return fail("broker_failure", 500);
            const successorResult = await tx.execute({
              sql: "SELECT * FROM a1_generations WHERE channel_generation = ?",
              args: [generation.next_generation],
            });
            const successorRow = successorResult.rows[0];
            if (successorRow === undefined) return fail("broker_failure", 500);
            return { sealed: generation, successor: generationDescriptor(successorRow) } as const;
          }
          if (current !== expectedGeneration) return fail("generation_mismatch", 409);
          if (current >= Number.MAX_SAFE_INTEGER) return fail("counter_exhausted", 507);
          const digest = await manifestDigest(
            route.brokerRouteId,
            current,
            generation.next_frame_index,
          );
          const now = Date.now();
          await tx.execute({
            sql: `UPDATE a1_generations
                     SET state = 'sealed', frame_count = ?, next_generation = ?,
                         manifest_digest = ?, sealed_at = ?
                   WHERE channel_generation = ? AND state = 'open'`,
            args: [generation.next_frame_index, current + 1, digest, now, current],
          });
          await tx.execute({
            sql: `INSERT INTO a1_generations
                    (channel_generation, state, frame_count, next_generation, manifest_digest,
                     next_frame_index, created_at, sealed_at)
                  VALUES (?, 'open', NULL, NULL, NULL, 0, ?, NULL)`,
            args: [current + 1, now],
          });
          await tx.execute({
            sql: "UPDATE a1_route SET current_generation = ? WHERE singleton = 1",
            args: [current + 1],
          });
          return {
            sealed: {
              channel_generation: current,
              state: "sealed",
              frame_count: generation.next_frame_index,
              next_generation: current + 1,
              manifest_digest: digest,
              next_frame_index: generation.next_frame_index,
            },
            successor: {
              channel_generation: current + 1,
              state: "open",
              frame_count: null,
              next_generation: null,
              manifest_digest: null,
              next_frame_index: 0,
            },
          } as const;
        }),
      );
    } finally {
      opened.client.close();
    }
  }
}

type GlobalWithA1Backend = typeof globalThis & {
  __remoteClawA1Backend?: A1SqliteBackend;
};

/** Process-wide singleton shared by the separately bundled Next route modules. */
export function getA1SqliteBackend(): A1SqliteBackend {
  const global = globalThis as GlobalWithA1Backend;
  if (global.__remoteClawA1Backend === undefined) {
    global.__remoteClawA1Backend = new A1SqliteBackend();
  }
  return global.__remoteClawA1Backend;
}

/** Test/dev hook: the next call reselects the env-configured locator. */
export function evictA1SqliteBackend(): void {
  delete (globalThis as GlobalWithA1Backend).__remoteClawA1Backend;
}

export type { A1EncryptedFrameV2 };
