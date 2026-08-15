import {
  A1BrokerContractError,
  type A1BrokerRoute,
  type A1EncryptedFrameV2,
  A1WireError,
  deriveA1BrokerRouteId,
  deriveA1ChatToken,
  deriveA1ScopeToken,
  deriveA1ServerControlToken,
  fromHex,
  parseA1BrokerRouteStoreInstanceId,
  timingSafeEqual,
  toHex,
} from "@remote-claw/clawsec";
import { AuthError, identityFromRequest } from "../auth";
import {
  A1_BROKER_CAPABILITIES_DIGEST,
  A1_CAPABILITIES_DIGEST_HEADER,
  A1_ROUTE_KIND_HEADER,
  A1_ROUTE_STORE_INSTANCE_HEADER,
  A1_ROUTE_TOKEN_HEADER,
  A1BrokerError,
  type A1ErrorCode,
  type A1GenerationDescriptor,
  type A1ReadPositionV1,
  type A1RouteCoordinates,
} from "./a1-contract";
import {
  exactRecord,
  nullableString,
  parseStrictControlJson,
  requiredLiteral,
  requiredSafeUint,
  requiredString,
} from "./a1-json";
import { BACKEND_HEADER } from "./index";

const COMMON_ROUTE_KEYS = [
  "v",
  "identity_id",
  "collaboration_server_id",
  "route_kind",
  "logical_chat_id",
  "route_token",
  "expected_route_store_instance_id",
] as const;
const SUBSCRIBE_KEYS = [...COMMON_ROUTE_KEYS, "position", "max_frames"] as const;
const POSITION_KEYS = ["version", "channel_generation", "next_frame_index"] as const;
const IDENTITY_HEX = /^[0-9a-f]{32}$/;
const A1_BEARER = /^Bearer [0-9a-f]{64}$/;
const CANONICAL_DIGEST = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();
const TURSO_FLEET_ENV = [
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_GROUP_AUTH_TOKEN",
] as const;

export interface ParsedRouteRequest {
  readonly route: A1RouteCoordinates;
  readonly expectedRouteStoreInstanceId: string | null;
}

export interface ParsedSubscribeRequest extends ParsedRouteRequest {
  readonly expectedRouteStoreInstanceId: string;
  readonly position: A1ReadPositionV1;
  readonly maxFrames: number;
}

function fail(code: ConstructorParameters<typeof A1BrokerError>[0], status: number): never {
  throw new A1BrokerError(code, status);
}

function constantTimeAsciiEqual(left: string, right: string): boolean {
  return timingSafeEqual(textEncoder.encode(left), textEncoder.encode(right));
}

/** Selected A1 advertises durable semantics, so it must never inherit the A0 locator's permissive
 * partial-config fallback. Vercel requires the remote fleet even when RC_SQLITE_DIR is explicitly set;
 * local/self-hosted conformance may use files only when no Turso fleet variable is configured. */
export function assertA1BackendAvailable(): void {
  const configured = TURSO_FLEET_ENV.filter((name) => {
    const value = process.env[name];
    return value !== undefined && value.trim() !== "";
  }).length;
  if (
    (process.env.VERCEL === "1" && configured !== TURSO_FLEET_ENV.length) ||
    (configured !== 0 && configured !== TURSO_FLEET_ENV.length)
  ) {
    fail("a1_backend_unsupported", 501);
  }
}

export function a1Json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      [A1_CAPABILITIES_DIGEST_HEADER]: A1_BROKER_CAPABILITIES_DIGEST,
    },
  });
}

/** The durable generation record excludes the sampled open tail. HTTP operations carry that sample
 * once at top level as `observed_next_frame_index`, keeping immutable manifest data distinct. */
export function a1GenerationJson(generation: A1GenerationDescriptor): {
  channel_generation: number;
  state: "open" | "sealed";
  frame_count: number | null;
  next_generation: number | null;
  manifest_digest: string | null;
} {
  return {
    channel_generation: generation.channel_generation,
    state: generation.state,
    frame_count: generation.frame_count,
    next_generation: generation.next_generation,
    manifest_digest: generation.manifest_digest,
  };
}

export function a1Error(error: unknown): Response {
  if (AuthError.is(error)) return a1Json({ v: 1, error: "unauthorized" }, 401);
  if (A1BrokerError.is(error)) return a1Json({ v: 1, error: error.code }, error.status);
  // Do not echo driver/database messages: they can contain locators, credentials, or route material.
  console.error("[a1-broker] request failed", error instanceof Error ? error.name : typeof error);
  return a1Json({ v: 1, error: "broker_failure" }, 500);
}

export async function admitA1Request(
  req: Request,
  requirePinnedCapabilities: boolean,
): Promise<Uint8Array> {
  // The selected A1 surface freezes one canonical bearer spelling. Keep this gate local to A1 so
  // the established A0 admission contract remains unchanged.
  const authorization = req.headers.get("authorization");
  if (authorization === null || !A1_BEARER.test(authorization)) {
    throw new AuthError("invalid selected-A1 bearer");
  }
  const identityId = await identityFromRequest(req);
  const selected = req.headers.get(BACKEND_HEADER);
  if (selected === null) fail("backend_selector_required", 400);
  if (selected !== "sqlite") fail("a1_backend_unsupported", 501);
  assertA1BackendAvailable();
  if (requirePinnedCapabilities) {
    const digest = req.headers.get(A1_CAPABILITIES_DIGEST_HEADER);
    if (digest === null || !CANONICAL_DIGEST.test(digest)) fail("invalid_request", 400);
    if (digest !== A1_BROKER_CAPABILITIES_DIGEST) {
      fail("broker_capabilities_mismatch", 409);
    }
  }
  return identityId;
}

export function requireJsonContentType(req: Request): void {
  const value = req.headers.get("content-type");
  if (value === null || !/^application\/json(?:\s*;.*)?$/i.test(value)) {
    fail("unsupported_media_type", 415);
  }
}

/** Incrementally consume a body into a fixed-size buffer. `Request.text()` is intentionally forbidden
 * here: a chunked sender must not turn the documented cap into unbounded transient allocation. */
export async function readBoundedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const length = req.headers.get("content-length");
  if (length !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(length)) fail("invalid_request", 400);
    const parsed = Number(length);
    if (!Number.isSafeInteger(parsed)) fail("invalid_request", 400);
    if (parsed > maxBytes) fail("frame_too_large", 413);
  }
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The peer may already have closed the body.
        }
        return fail("frame_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function parseStoreInstanceId(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  try {
    return parseA1BrokerRouteStoreInstanceId(value);
  } catch (error) {
    if (!A1BrokerContractError.is(error)) throw error;
    return fail("invalid_request", 400);
  }
}

async function coordinatesFromFields(
  row: Record<string, unknown>,
  authenticatedIdentityId: Uint8Array,
): Promise<A1RouteCoordinates> {
  requiredLiteral(row.v, 1);
  const identityHex = requiredString(row.identity_id);
  if (!IDENTITY_HEX.test(identityHex)) fail("invalid_request", 400);
  const suppliedIdentity = fromHex(identityHex);
  if (!timingSafeEqual(suppliedIdentity, authenticatedIdentityId)) {
    fail("route_auth_mismatch", 403);
  }
  const collaborationServerId = requiredString(row.collaboration_server_id);
  const routeKind = requiredString(row.route_kind);
  const logicalChatId = nullableString(row.logical_chat_id);
  const suppliedToken = requiredString(row.route_token);

  let route: A1BrokerRoute;
  let routeToken: string;
  try {
    if (routeKind === "chat") {
      if (logicalChatId === null) fail("invalid_request", 400);
      route = {
        routeKind: "chat",
        identityId: authenticatedIdentityId,
        collaborationServerId,
        logicalChatId,
      };
      routeToken = await deriveA1ChatToken(
        authenticatedIdentityId,
        collaborationServerId,
        logicalChatId,
      );
    } else if (routeKind === "scope_bus" || routeKind === "server_control") {
      if (logicalChatId !== null) fail("invalid_request", 400);
      route = {
        routeKind,
        identityId: authenticatedIdentityId,
        collaborationServerId,
        logicalChatId: null,
      };
      routeToken =
        routeKind === "scope_bus"
          ? await deriveA1ScopeToken(authenticatedIdentityId, collaborationServerId)
          : await deriveA1ServerControlToken(authenticatedIdentityId, collaborationServerId);
    } else {
      return fail("invalid_request", 400);
    }
  } catch (error) {
    if (A1BrokerError.is(error)) throw error;
    if (A1WireError.is(error)) return fail("invalid_request", 400);
    throw error;
  }
  if (!constantTimeAsciiEqual(suppliedToken, routeToken)) fail("route_auth_mismatch", 403);
  return {
    brokerRouteId: await deriveA1BrokerRouteId(route),
    identityIdHex: toHex(authenticatedIdentityId),
    route,
    routeKind: route.routeKind,
    collaborationServerId,
    logicalChatId: route.logicalChatId,
    routeToken,
  };
}

export async function parseRouteRequest(
  raw: Uint8Array,
  authenticatedIdentityId: Uint8Array,
): Promise<ParsedRouteRequest> {
  const row = exactRecord(parseStrictControlJson(raw), COMMON_ROUTE_KEYS);
  return {
    route: await coordinatesFromFields(row, authenticatedIdentityId),
    expectedRouteStoreInstanceId: parseStoreInstanceId(row.expected_route_store_instance_id, true),
  };
}

export async function parseSubscribeRequest(
  raw: Uint8Array,
  authenticatedIdentityId: Uint8Array,
): Promise<ParsedSubscribeRequest> {
  const row = exactRecord(parseStrictControlJson(raw), SUBSCRIBE_KEYS);
  const expected = parseStoreInstanceId(row.expected_route_store_instance_id, false);
  if (expected === null) return fail("invalid_request", 400);
  const positionRow = exactRecord(row.position, POSITION_KEYS);
  requiredLiteral(positionRow.version, 1);
  const position: A1ReadPositionV1 = {
    version: 1,
    channel_generation: requiredSafeUint(positionRow.channel_generation),
    next_frame_index: requiredSafeUint(positionRow.next_frame_index),
  };
  const maxFrames = requiredSafeUint(row.max_frames);
  if (maxFrames < 1 || maxFrames > 64) fail("invalid_request", 400);
  return {
    route: await coordinatesFromFields(row, authenticatedIdentityId),
    expectedRouteStoreInstanceId: expected,
    position,
    maxFrames,
  };
}

export async function routeFromRelayFrame(
  req: Request,
  authenticatedIdentityId: Uint8Array,
  frame: A1EncryptedFrameV2,
): Promise<{ route: A1RouteCoordinates; expectedRouteStoreInstanceId: string }> {
  if (!timingSafeEqual(frame.identityId, authenticatedIdentityId)) {
    return fail("route_auth_mismatch", 403);
  }
  const routeKind = req.headers.get(A1_ROUTE_KIND_HEADER);
  const suppliedToken = req.headers.get(A1_ROUTE_TOKEN_HEADER);
  const storeId = parseStoreInstanceId(req.headers.get(A1_ROUTE_STORE_INSTANCE_HEADER), false);
  if (storeId === null || suppliedToken === null) return fail("invalid_request", 400);

  let route: A1BrokerRoute;
  let routeToken: string;
  try {
    if (routeKind === "chat") {
      if (frame.logicalChatId === null) return fail("route_auth_mismatch", 403);
      route = {
        routeKind: "chat",
        identityId: authenticatedIdentityId,
        collaborationServerId: frame.collaborationServerId,
        logicalChatId: frame.logicalChatId,
      };
      routeToken = await deriveA1ChatToken(
        authenticatedIdentityId,
        frame.collaborationServerId,
        frame.logicalChatId,
      );
    } else if (routeKind === "scope_bus" || routeKind === "server_control") {
      route = {
        routeKind,
        identityId: authenticatedIdentityId,
        collaborationServerId: frame.collaborationServerId,
        logicalChatId: null,
      };
      routeToken =
        routeKind === "scope_bus"
          ? await deriveA1ScopeToken(authenticatedIdentityId, frame.collaborationServerId)
          : await deriveA1ServerControlToken(authenticatedIdentityId, frame.collaborationServerId);
    } else {
      return fail("invalid_request", 400);
    }
  } catch (error) {
    if (A1BrokerError.is(error)) throw error;
    if (A1WireError.is(error)) return fail("route_auth_mismatch", 403);
    throw error;
  }
  if (!constantTimeAsciiEqual(suppliedToken, routeToken)) {
    return fail("route_auth_mismatch", 403);
  }
  return {
    route: {
      brokerRouteId: await deriveA1BrokerRouteId(route),
      identityIdHex: toHex(authenticatedIdentityId),
      route,
      routeKind: route.routeKind,
      collaborationServerId: frame.collaborationServerId,
      logicalChatId: route.logicalChatId,
      routeToken,
    },
    expectedRouteStoreInstanceId: storeId,
  };
}

export function safeErrorBody(code: A1ErrorCode): { v: 1; error: A1ErrorCode } {
  return { v: 1, error: code };
}
