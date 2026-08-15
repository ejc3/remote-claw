import { createHash, timingSafeEqual } from "node:crypto";
import {
  type A1BrokerEnsureRouteReceiptV1,
  type A1BrokerRoute,
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  canonicalA1BrokerRouteAddressPreimage,
  canonicalA1BrokerRouteIdPreimage,
  parseA1BrokerOrigin,
  parseA1BrokerRouteStoreInstanceId,
} from "@remote-claw/clawsec";
import {
  BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
  type BrokerBackendCapabilitiesV1,
  canonicalBrokerBackendCapabilitiesV1,
  REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
} from "./backend.js";
import {
  type A1Digest,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  HostStateContractError,
  type LogicalChatId,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseMachineIdentityId,
} from "./ids.js";
import { type ProtectedHandleRef, parseProtectedHandleRef } from "./protected.js";
import type { CoordinatorLeaseFence } from "./records.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseLiteral,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
} from "./validation.js";

declare const brokerRouteIdBrand: unique symbol;
declare const brokerCapabilityPinIdBrand: unique symbol;
declare const brokerStoreInstanceIdBrand: unique symbol;
declare const brokerRouteTokenBrand: unique symbol;

export type BrokerRouteId = string & { readonly [brokerRouteIdBrand]: true };
export type BrokerBackendCapabilityPinId = string & {
  readonly [brokerCapabilityPinIdBrand]: true;
};
export type BrokerRouteStoreInstanceId = string & {
  readonly [brokerStoreInstanceIdBrand]: true;
};
export type BrokerRouteToken = string & { readonly [brokerRouteTokenBrand]: true };

export const BROKER_CAPABILITY_PIN_ID_DOMAIN = "remote-claw/a1/broker-capability-pin/v1" as const;
export const BROKER_ROUTE_OPEN_RECEIPT_SCHEMA_ID =
  "remote-claw/a1/broker-route-open-receipt/v1" as const;

export const BROKER_ROUTE_KINDS = Object.freeze(["scope_bus", "server_control", "chat"] as const);
export type BrokerRouteKind = (typeof BROKER_ROUTE_KINDS)[number];
export type BrokerBackendSelector = "sqlite";

export interface BrokerBackendCapabilityPinRecord {
  readonly brokerBackendCapabilityPinId: BrokerBackendCapabilityPinId;
  readonly machineIdentityId: string;
  readonly brokerOrigin: string;
  readonly brokerBackendSelector: "sqlite";
  readonly canonicalPayloadSchemaId: typeof BROKER_BACKEND_CAPABILITIES_SCHEMA_ID;
  readonly canonicalPayloadRef: ProtectedHandleId;
  readonly canonicalPayloadDigest: A1Digest;
  readonly observedAtMs: number;
}

export interface BrokerRouteRecord {
  readonly brokerRouteId: BrokerRouteId;
  readonly machineIdentityId: string;
  readonly collaborationServerId: CollaborationServerId;
  readonly routeKind: BrokerRouteKind;
  readonly logicalChatId: LogicalChatId | null;
  readonly routeToken: BrokerRouteToken;
  readonly brokerOrigin: string;
  readonly brokerBackendSelector: "sqlite";
  readonly brokerRouteStoreInstanceId: BrokerRouteStoreInstanceId;
  readonly genesisGeneration: 0;
  readonly brokerBackendCapabilitiesRef: BrokerBackendCapabilityPinId;
  readonly brokerBackendCapabilitiesDigest: A1Digest;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly createdAtMs: number;
  readonly state: "current" | "quarantined" | "closed";
}

export interface BrokerChannelGenerationRecord {
  readonly brokerRouteId: BrokerRouteId;
  readonly channelGeneration: number;
  readonly frameCount: number | null;
  readonly nextGeneration: number | null;
  readonly state: "open" | "sealed";
  readonly manifestDigest: A1Digest | null;
}

/** Normalized, already-authenticated result of the broker's route-open operation. */
export interface ConfirmedBrokerRouteOpenReceiptV1
  extends Omit<
    A1BrokerEnsureRouteReceiptV1,
    "route" | "genesis" | "currentGeneration" | "observedNextFrameIndex"
  > {
  readonly schemaVersion: 1;
  readonly disposition: "created" | "existing";
  readonly route: Readonly<{
    schemaVersion: 1;
    brokerOrigin: string;
    backendSelector: "sqlite";
    routeStoreInstanceId: BrokerRouteStoreInstanceId;
    identityId: string;
    collaborationServerId: CollaborationServerId;
    routeKind: BrokerRouteKind;
    logicalChatId: LogicalChatId | null;
    brokerRouteId: BrokerRouteId;
    routeToken: BrokerRouteToken;
    brokerBackendCapabilitiesDigest: A1Digest;
  }>;
  readonly genesis: Readonly<{
    schemaVersion: 1;
    brokerRouteId: BrokerRouteId;
    channelGeneration: 0;
    state: "open";
    frameCount: null;
    nextGeneration: null;
    manifestDigest: null;
  }>;
  readonly currentGeneration: Readonly<{
    schemaVersion: 1;
    brokerRouteId: BrokerRouteId;
    channelGeneration: 0;
    state: "open";
    frameCount: null;
    nextGeneration: null;
    manifestDigest: null;
  }>;
  readonly observedNextFrameIndex: 0;
}

export interface InstallBrokerRouteRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly routeKind: BrokerRouteKind;
  readonly logicalChatId: LogicalChatId | null;
  readonly brokerOrigin: string;
  readonly brokerBackendSelector: "sqlite";
  readonly capabilityArtifactRef: ProtectedHandleRef<"artifact">;
  readonly capabilityObservedAtMs: number;
  readonly routeOpenedAtMs: number;
  readonly receipt: ConfirmedBrokerRouteOpenReceiptV1;
}

const PIN_KEYS = [
  "brokerBackendCapabilityPinId",
  "machineIdentityId",
  "brokerOrigin",
  "brokerBackendSelector",
  "canonicalPayloadSchemaId",
  "canonicalPayloadRef",
  "canonicalPayloadDigest",
  "observedAtMs",
] as const;

const ROUTE_KEYS = [
  "brokerRouteId",
  "machineIdentityId",
  "collaborationServerId",
  "routeKind",
  "logicalChatId",
  "routeToken",
  "brokerOrigin",
  "brokerBackendSelector",
  "brokerRouteStoreInstanceId",
  "genesisGeneration",
  "brokerBackendCapabilitiesRef",
  "brokerBackendCapabilitiesDigest",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "createdAtMs",
  "state",
] as const;

const GENERATION_KEYS = [
  "brokerRouteId",
  "channelGeneration",
  "frameCount",
  "nextGeneration",
  "state",
  "manifestDigest",
] as const;

const RECEIPT_KEYS = [
  "schemaVersion",
  "disposition",
  "route",
  "genesis",
  "currentGeneration",
  "observedNextFrameIndex",
] as const;

const RECEIPT_ROUTE_KEYS = [
  "schemaVersion",
  "brokerOrigin",
  "backendSelector",
  "routeStoreInstanceId",
  "identityId",
  "collaborationServerId",
  "routeKind",
  "logicalChatId",
  "brokerRouteId",
  "routeToken",
  "brokerBackendCapabilitiesDigest",
] as const;

const RECEIPT_GENESIS_KEYS = [
  "schemaVersion",
  "brokerRouteId",
  "channelGeneration",
  "state",
  "frameCount",
  "nextGeneration",
  "manifestDigest",
] as const;

const INSTALL_KEYS = [
  "fence",
  "routeKind",
  "logicalChatId",
  "brokerOrigin",
  "brokerBackendSelector",
  "capabilityArtifactRef",
  "capabilityObservedAtMs",
  "routeOpenedAtMs",
  "receipt",
] as const;

const FENCE_KEYS = ["collaborationServerId", "coordinatorLeaseId", "coordinatorEpoch"] as const;

function canonicalBase64Id(
  value: unknown,
  prefix: string,
  bodyBytes: number,
  field: string,
): string {
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new HostStateContractError(`${field} must use the ${prefix} namespace`);
  }
  const encoded = value.slice(prefix.length);
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(encoded);
  } catch {
    throw new HostStateContractError(`${field} must be a canonical selected-A1 identifier`);
  }
  if (bytes.byteLength !== bodyBytes || base64urlEncode(bytes) !== encoded) {
    throw new HostStateContractError(`${field} must be a canonical selected-A1 identifier`);
  }
  return value;
}

export function parseBrokerRouteId(value: unknown, field = "brokerRouteId"): BrokerRouteId {
  return canonicalBase64Id(value, "rcr_", 32, field) as BrokerRouteId;
}

export function parseBrokerBackendCapabilityPinId(
  value: unknown,
  field = "brokerBackendCapabilityPinId",
): BrokerBackendCapabilityPinId {
  return canonicalBase64Id(value, "rbcp_", 32, field) as BrokerBackendCapabilityPinId;
}

export function parseBrokerRouteStoreInstanceId(
  value: unknown,
  field = "brokerRouteStoreInstanceId",
): BrokerRouteStoreInstanceId {
  try {
    return parseA1BrokerRouteStoreInstanceId(value) as BrokerRouteStoreInstanceId;
  } catch {
    throw new HostStateContractError(`${field} must be a canonical selected-A1 identifier`);
  }
}

export function parseBrokerOrigin(value: unknown, field = "brokerOrigin"): string {
  let parsed: string;
  try {
    parsed = parseA1BrokerOrigin(value);
  } catch {
    throw new HostStateContractError(`${field} must be a canonical HTTP(S) origin`);
  }
  if (parsed !== value) {
    throw new HostStateContractError(`${field} must be a canonical HTTP(S) origin`);
  }
  return parsed;
}

function digest(bytes: Uint8Array): A1Digest {
  return parseA1Digest(createHash("sha256").update(bytes).digest("base64url"));
}

export function syncBrokerBackendCapabilitiesDigestV1(
  value: BrokerBackendCapabilitiesV1,
): A1Digest {
  return digest(canonicalBrokerBackendCapabilitiesV1(value));
}

export function deriveBrokerBackendCapabilityPinId(
  brokerOrigin: string,
  brokerBackendSelector: "sqlite",
  canonicalPayloadDigest: A1Digest,
): BrokerBackendCapabilityPinId {
  const origin = parseBrokerOrigin(brokerOrigin);
  const selector = parseLiteral(
    brokerBackendSelector,
    "sqlite",
    "brokerBackendCapabilityPin.brokerBackendSelector",
  );
  const payloadDigest = parseA1Digest(
    canonicalPayloadDigest,
    "brokerBackendCapabilityPin.canonicalPayloadDigest",
  );
  const writer = new CanonicalWriter();
  writer.str(BROKER_CAPABILITY_PIN_ID_DOMAIN);
  writer.str(origin);
  writer.str(selector);
  writer.bytes(base64urlDecode(payloadDigest));
  return parseBrokerBackendCapabilityPinId(
    `rbcp_${base64urlEncode(createHash("sha256").update(writer.finish()).digest())}`,
  );
}

function identityBytes(machineIdentityId: string): Uint8Array {
  return new Uint8Array(Buffer.from(parseMachineIdentityId(machineIdentityId), "hex"));
}

function clawsecRoute(
  machineIdentityId: string,
  collaborationServerId: CollaborationServerId,
  routeKind: BrokerRouteKind,
  logicalChatId: LogicalChatId | null,
): A1BrokerRoute {
  const kind = parseEnum(routeKind, BROKER_ROUTE_KINDS, "brokerRoute.routeKind");
  const serverId = parseA1CanonicalId(
    "collaborationServer",
    collaborationServerId,
    "brokerRoute.collaborationServerId",
  );
  const identityId = identityBytes(machineIdentityId);
  if (kind === "chat") {
    return {
      routeKind: "chat",
      identityId,
      collaborationServerId: serverId,
      logicalChatId: parseA1CanonicalId("logicalChat", logicalChatId, "brokerRoute.logicalChatId"),
    };
  }
  if (logicalChatId !== null) {
    throw new HostStateContractError("brokerRoute.logicalChatId must be null for a non-chat route");
  }
  return {
    routeKind: kind,
    identityId,
    collaborationServerId: serverId,
    logicalChatId: null,
  };
}

export function deriveBrokerRouteToken(
  machineIdentityId: string,
  collaborationServerId: CollaborationServerId,
  routeKind: BrokerRouteKind,
  logicalChatId: LogicalChatId | null,
): BrokerRouteToken {
  const route = clawsecRoute(machineIdentityId, collaborationServerId, routeKind, logicalChatId);
  const kind = route.routeKind;
  const prefix =
    kind === "scope_bus" ? "bus:a1:" : kind === "server_control" ? "ctl:a1:" : "sess:a1:";
  const address = base64urlEncode(
    createHash("sha256").update(canonicalA1BrokerRouteAddressPreimage(route)).digest(),
  );
  return `${prefix}${address}` as BrokerRouteToken;
}

export function deriveBrokerRouteId(
  machineIdentityId: string,
  collaborationServerId: CollaborationServerId,
  routeKind: BrokerRouteKind,
  logicalChatId: LogicalChatId | null,
): BrokerRouteId {
  const route = clawsecRoute(machineIdentityId, collaborationServerId, routeKind, logicalChatId);
  return parseBrokerRouteId(
    `rcr_${base64urlEncode(
      createHash("sha256").update(canonicalA1BrokerRouteIdPreimage(route)).digest(),
    )}`,
  );
}

export function parseBrokerRouteToken(
  value: unknown,
  routeKind: BrokerRouteKind,
  field = "brokerRoute.routeToken",
): BrokerRouteToken {
  const prefix =
    routeKind === "scope_bus" ? "bus:a1:" : routeKind === "server_control" ? "ctl:a1:" : "sess:a1:";
  return canonicalBase64Id(value, prefix, 32, field) as BrokerRouteToken;
}

function parseArtifactRef(value: unknown, field: string): ProtectedHandleRef<"artifact"> {
  let parsed: ReturnType<typeof parseProtectedHandleRef>;
  try {
    parsed = parseProtectedHandleRef(value);
  } catch {
    throw new HostStateContractError(`${field} must be an artifact reference`);
  }
  if (parsed.kind !== "artifact") {
    throw new HostStateContractError(`${field} must be an artifact reference`);
  }
  return parsed;
}

function parseFence(value: unknown): CoordinatorLeaseFence {
  const row = parseExactRecord(value, FENCE_KEYS, "installBrokerRoute.fence");
  return frozen({
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "installBrokerRoute.fence.collaborationServerId",
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "installBrokerRoute.fence.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "installBrokerRoute.fence.coordinatorEpoch",
    ),
  });
}

function parseNull(value: unknown, field: string): null {
  if (value !== null) throw new HostStateContractError(`${field} must equal null`);
  return null;
}

export function parseConfirmedBrokerRouteOpenReceiptV1(
  value: unknown,
): ConfirmedBrokerRouteOpenReceiptV1 {
  const row = parseExactRecord(value, RECEIPT_KEYS, "brokerRouteOpenReceipt");
  const route = parseExactRecord(row.route, RECEIPT_ROUTE_KEYS, "brokerRouteOpenReceipt.route");
  const routeKind = parseEnum(
    route.routeKind,
    BROKER_ROUTE_KINDS,
    "brokerRouteOpenReceipt.route.routeKind",
  );
  const logicalChatId =
    route.logicalChatId === null
      ? null
      : parseA1CanonicalId(
          "logicalChat",
          route.logicalChatId,
          "brokerRouteOpenReceipt.route.logicalChatId",
        );
  if ((routeKind === "chat") !== (logicalChatId !== null)) {
    throw new HostStateContractError(
      "brokerRouteOpenReceipt.route.logicalChatId must be non-null exactly for a chat route",
    );
  }
  const genesis = parseExactRecord(
    row.genesis,
    RECEIPT_GENESIS_KEYS,
    "brokerRouteOpenReceipt.genesis",
  );
  const currentGeneration = parseExactRecord(
    row.currentGeneration,
    RECEIPT_GENESIS_KEYS,
    "brokerRouteOpenReceipt.currentGeneration",
  );
  const brokerRouteId = parseBrokerRouteId(
    route.brokerRouteId,
    "brokerRouteOpenReceipt.route.brokerRouteId",
  );
  const genesisBrokerRouteId = parseBrokerRouteId(
    genesis.brokerRouteId,
    "brokerRouteOpenReceipt.genesis.brokerRouteId",
  );
  if (brokerRouteId !== genesisBrokerRouteId) {
    throw new HostStateContractError(
      "brokerRouteOpenReceipt.genesis.brokerRouteId must equal its route",
    );
  }
  const currentBrokerRouteId = parseBrokerRouteId(
    currentGeneration.brokerRouteId,
    "brokerRouteOpenReceipt.currentGeneration.brokerRouteId",
  );
  if (brokerRouteId !== currentBrokerRouteId) {
    throw new HostStateContractError(
      "brokerRouteOpenReceipt.currentGeneration.brokerRouteId must equal its route",
    );
  }
  return frozen({
    schemaVersion: parseLiteral(row.schemaVersion, 1, "brokerRouteOpenReceipt.schemaVersion"),
    disposition: parseEnum(
      row.disposition,
      ["created", "existing"] as const,
      "brokerRouteOpenReceipt.disposition",
    ),
    route: frozen({
      schemaVersion: parseLiteral(
        route.schemaVersion,
        1,
        "brokerRouteOpenReceipt.route.schemaVersion",
      ),
      brokerOrigin: parseBrokerOrigin(
        route.brokerOrigin,
        "brokerRouteOpenReceipt.route.brokerOrigin",
      ),
      backendSelector: parseLiteral(
        route.backendSelector,
        "sqlite",
        "brokerRouteOpenReceipt.route.backendSelector",
      ),
      routeStoreInstanceId: parseBrokerRouteStoreInstanceId(
        route.routeStoreInstanceId,
        "brokerRouteOpenReceipt.route.routeStoreInstanceId",
      ),
      identityId: parseMachineIdentityId(
        route.identityId,
        "brokerRouteOpenReceipt.route.identityId",
      ),
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        route.collaborationServerId,
        "brokerRouteOpenReceipt.route.collaborationServerId",
      ),
      routeKind,
      logicalChatId,
      brokerRouteId,
      routeToken: parseBrokerRouteToken(
        route.routeToken,
        routeKind,
        "brokerRouteOpenReceipt.route.routeToken",
      ),
      brokerBackendCapabilitiesDigest: parseA1Digest(
        route.brokerBackendCapabilitiesDigest,
        "brokerRouteOpenReceipt.route.brokerBackendCapabilitiesDigest",
      ),
    }),
    genesis: frozen({
      schemaVersion: parseLiteral(
        genesis.schemaVersion,
        1,
        "brokerRouteOpenReceipt.genesis.schemaVersion",
      ),
      brokerRouteId: genesisBrokerRouteId,
      channelGeneration: parseLiteral(
        genesis.channelGeneration,
        0,
        "brokerRouteOpenReceipt.genesis.channelGeneration",
      ),
      state: parseLiteral(genesis.state, "open", "brokerRouteOpenReceipt.genesis.state"),
      frameCount: parseNull(genesis.frameCount, "brokerRouteOpenReceipt.genesis.frameCount"),
      nextGeneration: parseNull(
        genesis.nextGeneration,
        "brokerRouteOpenReceipt.genesis.nextGeneration",
      ),
      manifestDigest: parseNull(
        genesis.manifestDigest,
        "brokerRouteOpenReceipt.genesis.manifestDigest",
      ),
    }),
    currentGeneration: frozen({
      schemaVersion: parseLiteral(
        currentGeneration.schemaVersion,
        1,
        "brokerRouteOpenReceipt.currentGeneration.schemaVersion",
      ),
      brokerRouteId: currentBrokerRouteId,
      channelGeneration: parseLiteral(
        currentGeneration.channelGeneration,
        0,
        "brokerRouteOpenReceipt.currentGeneration.channelGeneration",
      ),
      state: parseLiteral(
        currentGeneration.state,
        "open",
        "brokerRouteOpenReceipt.currentGeneration.state",
      ),
      frameCount: parseNull(
        currentGeneration.frameCount,
        "brokerRouteOpenReceipt.currentGeneration.frameCount",
      ),
      nextGeneration: parseNull(
        currentGeneration.nextGeneration,
        "brokerRouteOpenReceipt.currentGeneration.nextGeneration",
      ),
      manifestDigest: parseNull(
        currentGeneration.manifestDigest,
        "brokerRouteOpenReceipt.currentGeneration.manifestDigest",
      ),
    }),
    observedNextFrameIndex: parseLiteral(
      row.observedNextFrameIndex,
      0,
      "brokerRouteOpenReceipt.observedNextFrameIndex",
    ),
  });
}

export function parseInstallBrokerRouteRequest(value: unknown): InstallBrokerRouteRequest {
  const row = parseExactRecord(value, INSTALL_KEYS, "installBrokerRoute");
  const routeKind = parseEnum(row.routeKind, BROKER_ROUTE_KINDS, "installBrokerRoute.routeKind");
  const logicalChatId =
    row.logicalChatId === null
      ? null
      : parseA1CanonicalId("logicalChat", row.logicalChatId, "installBrokerRoute.logicalChatId");
  if ((routeKind === "chat") !== (logicalChatId !== null)) {
    throw new HostStateContractError(
      "installBrokerRoute.logicalChatId must be non-null exactly for a chat route",
    );
  }
  const capabilityObservedAtMs = parseNonNegativeSafeInteger(
    row.capabilityObservedAtMs,
    "installBrokerRoute.capabilityObservedAtMs",
  );
  const routeOpenedAtMs = parseNonNegativeSafeInteger(
    row.routeOpenedAtMs,
    "installBrokerRoute.routeOpenedAtMs",
  );
  if (capabilityObservedAtMs > routeOpenedAtMs) {
    throw new HostStateContractError(
      "installBrokerRoute.capabilityObservedAtMs must not be later than routeOpenedAtMs",
    );
  }
  return frozen({
    fence: parseFence(row.fence),
    routeKind,
    logicalChatId,
    brokerOrigin: parseBrokerOrigin(row.brokerOrigin, "installBrokerRoute.brokerOrigin"),
    brokerBackendSelector: parseLiteral(
      row.brokerBackendSelector,
      "sqlite",
      "installBrokerRoute.brokerBackendSelector",
    ),
    capabilityArtifactRef: parseArtifactRef(
      row.capabilityArtifactRef,
      "installBrokerRoute.capabilityArtifactRef",
    ),
    capabilityObservedAtMs,
    routeOpenedAtMs,
    receipt: parseConfirmedBrokerRouteOpenReceiptV1(row.receipt),
  });
}

export function parseBrokerBackendCapabilityPinRecord(
  value: unknown,
): BrokerBackendCapabilityPinRecord {
  const row = parseExactRecord(value, PIN_KEYS, "brokerBackendCapabilityPin");
  return frozen({
    brokerBackendCapabilityPinId: parseBrokerBackendCapabilityPinId(
      row.brokerBackendCapabilityPinId,
    ),
    machineIdentityId: parseMachineIdentityId(row.machineIdentityId),
    brokerOrigin: parseBrokerOrigin(row.brokerOrigin),
    brokerBackendSelector: parseLiteral(
      row.brokerBackendSelector,
      "sqlite",
      "brokerBackendCapabilityPin.brokerBackendSelector",
    ),
    canonicalPayloadSchemaId: parseLiteral(
      row.canonicalPayloadSchemaId,
      BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
      "brokerBackendCapabilityPin.canonicalPayloadSchemaId",
    ),
    canonicalPayloadRef: parseA1CanonicalId(
      "protectedHandle",
      row.canonicalPayloadRef,
      "brokerBackendCapabilityPin.canonicalPayloadRef",
    ),
    canonicalPayloadDigest: parseA1Digest(
      row.canonicalPayloadDigest,
      "brokerBackendCapabilityPin.canonicalPayloadDigest",
    ),
    observedAtMs: parseNonNegativeSafeInteger(
      row.observedAtMs,
      "brokerBackendCapabilityPin.observedAtMs",
    ),
  });
}

export function parseBrokerRouteRecord(value: unknown): BrokerRouteRecord {
  const row = parseExactRecord(value, ROUTE_KEYS, "brokerRoute");
  const routeKind = parseEnum(row.routeKind, BROKER_ROUTE_KINDS, "brokerRoute.routeKind");
  const logicalChatId =
    row.logicalChatId === null
      ? null
      : parseA1CanonicalId("logicalChat", row.logicalChatId, "brokerRoute.logicalChatId");
  if ((routeKind === "chat") !== (logicalChatId !== null)) {
    throw new HostStateContractError(
      "brokerRoute.logicalChatId must be non-null exactly for a chat route",
    );
  }
  return frozen({
    brokerRouteId: parseBrokerRouteId(row.brokerRouteId),
    machineIdentityId: parseMachineIdentityId(row.machineIdentityId),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "brokerRoute.collaborationServerId",
    ),
    routeKind,
    logicalChatId,
    routeToken: parseBrokerRouteToken(row.routeToken, routeKind),
    brokerOrigin: parseBrokerOrigin(row.brokerOrigin),
    brokerBackendSelector: parseLiteral(
      row.brokerBackendSelector,
      "sqlite",
      "brokerRoute.brokerBackendSelector",
    ),
    brokerRouteStoreInstanceId: parseBrokerRouteStoreInstanceId(row.brokerRouteStoreInstanceId),
    genesisGeneration: parseLiteral(row.genesisGeneration, 0, "brokerRoute.genesisGeneration"),
    brokerBackendCapabilitiesRef: parseBrokerBackendCapabilityPinId(
      row.brokerBackendCapabilitiesRef,
      "brokerRoute.brokerBackendCapabilitiesRef",
    ),
    brokerBackendCapabilitiesDigest: parseA1Digest(
      row.brokerBackendCapabilitiesDigest,
      "brokerRoute.brokerBackendCapabilitiesDigest",
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "brokerRoute.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "brokerRoute.coordinatorEpoch",
    ),
    createdAtMs: parseNonNegativeSafeInteger(row.createdAtMs, "brokerRoute.createdAtMs"),
    state: parseEnum(row.state, ["current", "quarantined", "closed"] as const, "brokerRoute.state"),
  });
}

export function parseBrokerChannelGenerationRecord(value: unknown): BrokerChannelGenerationRecord {
  const row = parseExactRecord(value, GENERATION_KEYS, "brokerChannelGeneration");
  const state = parseEnum(row.state, ["open", "sealed"] as const, "brokerChannelGeneration.state");
  const frameCount =
    row.frameCount === null
      ? null
      : parseNonNegativeSafeInteger(row.frameCount, "brokerChannelGeneration.frameCount");
  const nextGeneration =
    row.nextGeneration === null
      ? null
      : parsePositiveSafeInteger(row.nextGeneration, "brokerChannelGeneration.nextGeneration");
  const manifestDigest =
    row.manifestDigest === null
      ? null
      : parseA1Digest(row.manifestDigest, "brokerChannelGeneration.manifestDigest");
  const channelGeneration = parseNonNegativeSafeInteger(
    row.channelGeneration,
    "brokerChannelGeneration.channelGeneration",
  );
  if (
    state === "open"
      ? frameCount !== null || nextGeneration !== null || manifestDigest !== null
      : frameCount === null || nextGeneration !== channelGeneration + 1 || manifestDigest === null
  ) {
    throw new HostStateContractError(
      "brokerChannelGeneration lifecycle fields do not match its state",
    );
  }
  return frozen({
    brokerRouteId: parseBrokerRouteId(row.brokerRouteId),
    channelGeneration,
    frameCount,
    nextGeneration,
    state,
    manifestDigest,
  });
}

export function equalBrokerDigest(left: A1Digest, right: A1Digest): boolean {
  return timingSafeEqual(base64urlDecode(left), base64urlDecode(right));
}

export function parseRequiredBrokerCapabilitiesArtifact(
  bytes: Uint8Array,
): BrokerBackendCapabilitiesV1 {
  const expected = canonicalBrokerBackendCapabilitiesV1(REQUIRED_BROKER_BACKEND_CAPABILITIES_V1);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== expected.byteLength ||
    !timingSafeEqual(bytes, expected)
  ) {
    throw new HostStateContractError(
      "broker capability artifact must equal the canonical required capability vector",
    );
  }
  return REQUIRED_BROKER_BACKEND_CAPABILITIES_V1;
}
