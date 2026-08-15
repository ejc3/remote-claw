// Dormant A1.7a host-only ingress composition. This module is intentionally absent from every
// package barrel and production run path. Network/WebCrypto work is prepared here; the durable
// repository is the only authority allowed to commit the resulting evidence.

import { createHash, randomBytes } from "node:crypto";
import {
  A1_BROKER_MAX_READ_FRAMES,
  A1_INGRESS_MAX_OPENED_PART_BYTES,
  A1_INGRESS_SCHEDULER_CONCURRENCY,
  type A1BrokerRoute,
  type A1EncryptedFrameV2,
  type A1FrameHeaderV2,
  type A1IngressRoute,
  type A1Plane,
  a1AttemptHeaderDigest,
  a1IngressAuthenticatedPartDigest,
  a1PlaneForKind,
  assertA1FrameMatchesRoute,
  type BrokerChannelCursorV1,
  type BrokerReadPositionV1,
  deriveA1ChannelPositionObservationId,
  deriveA1IngressObservationId,
  deriveA1StableSemanticResultId,
  deriveA1WebSourceNamespaceId,
  openA1FramePart,
  parseA1BrokerCanonicalFrameV1,
  parseSelectedA1InboundPayload,
} from "@remote-claw/clawsec";
import type {
  InternalA1BrokerEvidenceReader,
  InternalA1BrokerReadEvidenceFrameV1,
  InternalA1BrokerReadEvidencePageV1,
} from "../../broker/a1-client.js";
import {
  A1BrokerHttpError,
  A1BrokerOutcomeUnknownError,
  A1BrokerProtocolError,
} from "../../broker/a1-client.js";
import type { BrokerRouteId } from "./broker-route.js";
import type { A1Digest, A1SafeId, ProtectedHandleId } from "./ids.js";
import { parseA1SafeId } from "./ids.js";
import type {
  BrokerRouteActorScope,
  ClassifyInboundPartRequest,
  ClassifyInvalidIngressPositionRequest,
  ClassifyUnknownOutboundPositionRequest,
  ExpireIngressResultRequest,
  IngressMutationResult,
  IngressPartClassificationResult,
  IngressRepositoryOperations,
  IngressRouteActorRecord,
  IngressRouteHead,
  LatchIngressStorageQuotaGapRequest,
  ParsedIngressPositionEvidence,
  PendingIngressPosition,
  StageIngressReadPageRequest,
} from "./ingress-repository.js";
import {
  A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
  A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID,
  A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
  A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
  IngressRepositoryQuotaError,
} from "./ingress-repository.js";
import { ProtectedByteSnapshot, type ProtectedHandleRef } from "./protected.js";
import type { CoordinatorLeaseFence } from "./records.js";
import { HostStateCommitOutcomeUnknownError } from "./sqlite.js";

export const DORMANT_A1_INGRESS_PENDING_BATCH = A1_BROKER_MAX_READ_FRAMES;

type IngressArtifactScope = Readonly<{
  scopeKind: "collaboration_server";
  scopeId: BrokerRouteActorScope["collaborationServerId"];
}>;

export interface DormantIngressTransaction {
  readonly ingress: IngressRepositoryOperations;
  putArtifact(
    request: IngressArtifactScope & {
      readonly artifactSchemaId: string;
      readonly artifactDigest: A1Digest;
      readonly artifactBytes: ProtectedByteSnapshot;
    },
  ): Readonly<{ artifactRef: ProtectedHandleRef<"artifact"> }>;
  readVerifiedArtifact(
    request: IngressArtifactScope & {
      readonly artifactRef: ProtectedHandleRef<"artifact">;
      readonly artifactSchemaId: string;
      readonly expectedArtifactDigest: A1Digest;
    },
  ): Readonly<{ artifactBytes: ProtectedByteSnapshot }>;
}

export interface DormantIngressDatabase {
  readonly machineIdentityId: string;
  readonly ingress: IngressRepositoryOperations;
  transaction<T>(operation: (transaction: DormantIngressTransaction) => T): T;
  close(): void;
}

export interface DormantA1IngressRouteActorOptions {
  readonly database: DormantIngressDatabase;
  readonly reopenDatabase: () => DormantIngressDatabase;
  readonly scope: BrokerRouteActorScope;
  readonly fence: CoordinatorLeaseFence;
  readonly actorClaimToken: A1SafeId;
  readonly evidenceReader: InternalA1BrokerEvidenceReader;
  readonly resolvePlaneKey: A1IngressPlaneKeyResolver;
  readonly openPart?: A1IngressPartOpener;
  readonly allocateOperationId?: () => A1SafeId;
  readonly nowMs?: () => number;
}

export type DormantIngressRouteCycleResult = Readonly<{
  fetched: boolean;
  stagedFrames: number;
  processedPositions: number;
  awaitingOrder: number;
  atLiveTail: boolean;
}>;

export type A1IngressPlaneKeyResolver = (
  route: A1BrokerRoute,
  plane: Extract<A1Plane, "content" | "server_control_in">,
  frame: A1EncryptedFrameV2,
) => Promise<Uint8Array>;

export type A1IngressPartOpener = (
  planeKey: Uint8Array,
  frame: A1EncryptedFrameV2,
) => Promise<Uint8Array>;

export interface PreparedIngressEvidenceFrame {
  readonly cursor: BrokerChannelCursorV1;
  readonly channelPositionObservationId: A1SafeId;
  readonly claimedDeliveryAttemptId: string;
  readonly claimedPart: number;
  readonly claimedTransportFrameDigest: A1Digest;
  readonly rawFrameBytes: Uint8Array;
  readonly rawFrameDigest: A1Digest;
}

export interface PreparedIngressEvidencePage {
  readonly page: InternalA1BrokerReadEvidencePageV1;
  readonly pageEvidenceBytes: Uint8Array;
  readonly pageEvidenceDigest: A1Digest;
  readonly frames: readonly PreparedIngressEvidenceFrame[];
}

function isExactRetainedOpenTail(
  state: IngressRouteHead | null,
  prepared: PreparedIngressEvidencePage,
): boolean {
  if (state === null) return false;
  const page = prepared.page;
  if (
    page.frames.length !== 0 ||
    page.generation.state !== "open" ||
    !page.atLiveTail ||
    page.requestedPosition.channelGeneration !== page.nextPosition.channelGeneration ||
    page.requestedPosition.nextFrameIndex !== page.nextPosition.nextFrameIndex ||
    page.observedNextFrameIndex !== page.requestedPosition.nextFrameIndex
  ) {
    return false;
  }
  const retained = state.currentGeneration;
  return (
    state.routeStoreInstanceId === page.routeStoreInstanceId &&
    retained.channelGeneration === page.generation.channelGeneration &&
    retained.state === "open" &&
    retained.observedNextFrameIndex === page.observedNextFrameIndex &&
    retained.frameCount === null &&
    retained.nextGeneration === null &&
    retained.manifestDigest === null
  );
}

export type InspectedPendingIngressFrame =
  | Readonly<{
      classification: "invalid";
      validationFailureCode: A1SafeId;
      parsed: ParsedIngressPositionEvidence | null;
    }>
  | Readonly<{
      classification: "unknown_outbound";
      validationFailureCode: null;
      parsed: ParsedIngressPositionEvidence;
    }>
  | Readonly<{
      classification: "inbound_ingress";
      validationFailureCode: null;
      parsed: ParsedIngressPositionEvidence;
      sourceEventNamespaceId: A1SafeId;
      stableSemanticResultId: A1SafeId;
      ingressObservationId: A1SafeId;
      plaintextPart: Uint8Array;
      plaintextPartDigest: A1Digest;
      authenticatedPartDigest: A1Digest;
    }>;

function sha256Digest(bytes: Uint8Array): A1Digest {
  return createHash("sha256").update(bytes).digest("base64url") as A1Digest;
}

function safeCode(value: string): A1SafeId {
  return value as A1SafeId;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function identityBytes(machineIdentityId: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(machineIdentityId)) {
    throw new TypeError("A1 ingress route identity must be 32 lowercase hexadecimal characters");
  }
  return Uint8Array.from(Buffer.from(machineIdentityId, "hex"));
}

/** Construct the exact route used for route-match-before-KDF enforcement. */
export function a1IngressRouteFromScope(
  machineIdentityId: string,
  scope: BrokerRouteActorScope,
): A1BrokerRoute {
  const identityId = identityBytes(machineIdentityId);
  return scope.routeKind === "chat"
    ? Object.freeze({
        routeKind: "chat",
        identityId,
        collaborationServerId: scope.collaborationServerId,
        logicalChatId: scope.logicalChatId,
      })
    : Object.freeze({
        routeKind: scope.routeKind,
        identityId,
        collaborationServerId: scope.collaborationServerId,
        logicalChatId: null,
      });
}

function pageEvidenceJson(page: InternalA1BrokerReadEvidencePageV1): string {
  // This is retained transport evidence, not a trusted inner-frame DTO. JSON.stringify uses the
  // explicit insertion order below and every nested object was already strict-parsed by the client.
  return JSON.stringify({
    v: 1,
    broker_route_id: page.brokerRouteId,
    route_store_instance_id: page.routeStoreInstanceId,
    requested_position: page.requestedPosition,
    generation: page.generation,
    observed_next_frame_index: page.observedNextFrameIndex,
    frames: page.frames.map((frame) => ({
      cursor: frame.cursor,
      delivery_attempt_id: frame.deliveryAttemptId,
      part: frame.part,
      transport_frame_digest: frame.transportFrameDigest,
      raw_frame_digest: sha256Digest(utf8(frame.rawFrame)),
    })),
    next_position: page.nextPosition,
    at_live_tail: page.atLiveTail,
  });
}

/** Snapshot all authenticated outer evidence before any inner-frame parsing is attempted. */
export async function prepareIngressEvidencePage(
  brokerRouteId: BrokerRouteId,
  page: InternalA1BrokerReadEvidencePageV1,
): Promise<PreparedIngressEvidencePage> {
  if (page.brokerRouteId !== brokerRouteId) {
    throw new TypeError("A1 ingress evidence page belongs to another broker route");
  }
  const frames = await Promise.all(
    page.frames.map(async (frame: InternalA1BrokerReadEvidenceFrameV1) => {
      const rawFrameBytes = utf8(frame.rawFrame);
      return Object.freeze({
        cursor: frame.cursor,
        channelPositionObservationId: (await deriveA1ChannelPositionObservationId(
          brokerRouteId,
          frame.cursor,
        )) as A1SafeId,
        claimedDeliveryAttemptId: frame.deliveryAttemptId,
        claimedPart: frame.part,
        claimedTransportFrameDigest: frame.transportFrameDigest as A1Digest,
        rawFrameBytes,
        rawFrameDigest: sha256Digest(rawFrameBytes),
      });
    }),
  );
  const pageEvidenceBytes = utf8(pageEvidenceJson(page));
  return Object.freeze({
    page,
    pageEvidenceBytes,
    pageEvidenceDigest: sha256Digest(pageEvidenceBytes),
    frames: Object.freeze(frames),
  });
}

function headerOf(frame: A1EncryptedFrameV2): A1FrameHeaderV2 {
  return frame;
}

function parsedEvidence(
  pending: PendingIngressPosition,
  frame: A1EncryptedFrameV2,
  normalizedTransportFrameDigest: A1Digest,
  stableLogicalHeaderDigest: A1Digest,
): ParsedIngressPositionEvidence {
  return Object.freeze({
    channelPositionObservationId: pending.channelPositionObservationId,
    normalizedTransportFrameDigest,
    header: Object.freeze({ ...headerOf(frame), identityId: new Uint8Array(frame.identityId) }),
    stableLogicalHeaderDigest,
  });
}

function invalid(
  code: string,
  parsed: ParsedIngressPositionEvidence | null = null,
): InspectedPendingIngressFrame {
  return Object.freeze({
    classification: "invalid",
    validationFailureCode: safeCode(code),
    parsed,
  });
}

/**
 * Inspect and open one durably staged frame. Route matching and broker-claim comparison complete
 * before the plane-key resolver is called. No repository transaction may surround this function.
 */
export async function inspectPendingIngressFrame(options: {
  readonly machineIdentityId: string;
  readonly scope: BrokerRouteActorScope;
  readonly pending: PendingIngressPosition;
  readonly rawFrameBytes: Uint8Array;
  readonly resolvePlaneKey: A1IngressPlaneKeyResolver;
  readonly openPart?: A1IngressPartOpener;
  readonly claimedDeliveryAttemptId: string;
  readonly claimedPart: number;
  readonly claimedTransportFrameDigest: A1Digest;
}): Promise<InspectedPendingIngressFrame> {
  let inspected: Awaited<ReturnType<typeof parseA1BrokerCanonicalFrameV1>>;
  try {
    inspected = await parseA1BrokerCanonicalFrameV1(options.rawFrameBytes);
  } catch {
    return invalid("invalid_frame");
  }
  const frame = inspected.frame;
  const route = a1IngressRouteFromScope(options.machineIdentityId, options.scope);
  const stableLogicalHeaderDigest = (await a1AttemptHeaderDigest(frame)) as A1Digest;
  const parsed = parsedEvidence(
    options.pending,
    frame,
    inspected.transportFrameDigest as A1Digest,
    stableLogicalHeaderDigest,
  );
  try {
    assertA1FrameMatchesRoute(frame, route);
  } catch {
    return invalid("route_mismatch", parsed);
  }
  if (
    frame.deliveryAttemptId !== options.claimedDeliveryAttemptId ||
    frame.part !== options.claimedPart ||
    inspected.transportFrameDigest !== options.claimedTransportFrameDigest
  ) {
    return invalid("outer_inner_claim_mismatch", parsed);
  }
  if (frame.dir === "out") {
    return Object.freeze({
      classification: "unknown_outbound",
      validationFailureCode: null,
      parsed,
    });
  }
  if (options.scope.routeKind === "scope_bus") {
    return invalid("scope_bus_inbound_forbidden", parsed);
  }
  if (frame.recordKind !== "user" && frame.recordKind !== "new_chat") {
    return invalid("unsupported_record_kind", parsed);
  }
  const plane = a1PlaneForKind(frame.recordKind);
  if (plane !== "content" && plane !== "server_control_in") {
    return invalid("unsupported_ingress_plane", parsed);
  }
  let plaintextPart: Uint8Array;
  const suppliedPlaneKey = await options.resolvePlaneKey(route, plane, frame);
  if (!(suppliedPlaneKey instanceof Uint8Array) || suppliedPlaneKey.byteLength !== 32) {
    throw new TypeError("A1 ingress plane-key resolver must return exactly 32 bytes");
  }
  const privatePlaneKey = new Uint8Array(suppliedPlaneKey);
  try {
    plaintextPart = await (options.openPart ?? openA1FramePart)(privatePlaneKey, frame);
  } catch {
    return invalid("aead_authentication_failed", parsed);
  } finally {
    privatePlaneKey.fill(0);
  }
  if (!(plaintextPart instanceof Uint8Array)) return invalid("invalid_plaintext_part", parsed);
  try {
    if (plaintextPart.byteLength > A1_INGRESS_MAX_OPENED_PART_BYTES) {
      return invalid("opened_part_too_large", parsed);
    }
    // A one-part payload is selected here for early rejection. Multipart payload validation remains
    // repository-finalization work after all verified retained parts are concatenated in index order.
    if (frame.parts === 1) {
      let selected: ReturnType<typeof parseSelectedA1InboundPayload> | undefined;
      try {
        selected = parseSelectedA1InboundPayload(frame, plaintextPart);
      } catch {
        return invalid("invalid_selected_payload", parsed);
      } finally {
        selected?.canonicalBytes.fill(0);
      }
    }
    // The scope-bus branch returned above; this reconstruction also gives TypeScript an exact
    // server-control/chat union instead of A1BrokerRoute's combined non-chat branch.
    const ingressRoute: A1IngressRoute =
      options.scope.routeKind === "chat"
        ? {
            routeKind: "chat",
            identityId: route.identityId,
            collaborationServerId: route.collaborationServerId,
            logicalChatId: options.scope.logicalChatId,
          }
        : {
            routeKind: "server_control",
            identityId: route.identityId,
            collaborationServerId: route.collaborationServerId,
            logicalChatId: null,
          };
    // Complete every fallible async derivation before allocating the copy returned to the caller.
    // The outer finally owns `plaintextPart`; once allocated, `retainedPlaintext` crosses no await.
    const sourceEventNamespaceId = (await deriveA1WebSourceNamespaceId(ingressRoute)) as A1SafeId;
    const stableSemanticResultId = (await deriveA1StableSemanticResultId(
      ingressRoute,
      sourceEventNamespaceId,
      frame.msgId,
    )) as A1SafeId;
    const ingressObservationId = (await deriveA1IngressObservationId(
      options.pending.channelPositionObservationId,
    )) as A1SafeId;
    const plaintextPartDigest = sha256Digest(plaintextPart);
    const authenticatedPartDigest = (await a1IngressAuthenticatedPartDigest(
      frame,
      plaintextPart,
    )) as A1Digest;
    const retainedPlaintext = new Uint8Array(plaintextPart);
    return Object.freeze({
      classification: "inbound_ingress",
      validationFailureCode: null,
      parsed,
      sourceEventNamespaceId,
      stableSemanticResultId,
      ingressObservationId,
      plaintextPart: retainedPlaintext,
      plaintextPartDigest,
      authenticatedPartDigest,
    });
  } finally {
    plaintextPart.fill(0);
  }
}

/** Run independent route lanes with a hard global bound; each supplied lane remains serialized. */
export async function runBoundedIngressRouteScheduler<T>(
  routes: readonly (() => Promise<T>)[],
  concurrency = A1_INGRESS_SCHEDULER_CONCURRENCY,
): Promise<readonly T[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new RangeError("A1 ingress scheduler concurrency must be an integer from 1 through 8");
  }
  const results = new Array<T>(routes.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const route = routes[index];
      if (route === undefined) return;
      results[index] = await route();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, routes.length) }, worker));
  return Object.freeze(results);
}

/** The actor always asks the broker for its exact durable fetch cursor, never the semantic cursor. */
export async function readIngressEvidencePage(
  reader: InternalA1BrokerEvidenceReader,
  position: BrokerReadPositionV1,
): Promise<InternalA1BrokerReadEvidencePageV1> {
  return reader.read({ position, maxFrames: DORMANT_A1_INGRESS_PENDING_BATCH });
}

function pageMatchesRequestedPosition(
  page: InternalA1BrokerReadEvidencePageV1,
  position: BrokerReadPositionV1,
): boolean {
  if (
    page.requestedPosition.channelGeneration !== position.channelGeneration ||
    page.requestedPosition.nextFrameIndex !== position.nextFrameIndex ||
    page.generation.channelGeneration !== position.channelGeneration
  ) {
    return false;
  }
  for (let index = 0; index < page.frames.length; index++) {
    const frame = page.frames[index];
    if (
      frame === undefined ||
      frame.cursor.channelGeneration !== position.channelGeneration ||
      frame.cursor.frameIndex !== position.nextFrameIndex + index
    ) {
      return false;
    }
  }
  return true;
}

function defaultOperationId(): A1SafeId {
  return parseA1SafeId(`ingop_${randomBytes(16).toString("base64url")}`, "ingress.operationId");
}

function artifactScope(scope: BrokerRouteActorScope): IngressArtifactScope {
  return Object.freeze({
    scopeKind: "collaboration_server",
    scopeId: scope.collaborationServerId,
  });
}

function artifactRef(protectedHandleId: ProtectedHandleId): ProtectedHandleRef<"artifact"> {
  return Object.freeze({ protectedHandleId, kind: "artifact" });
}

function gapEvidenceBytes(
  scope: BrokerRouteActorScope,
  failureCode: A1SafeId,
  channelPositionObservationId: A1SafeId | null,
  requestedPosition: BrokerReadPositionV1 | null,
): Uint8Array {
  return utf8(
    JSON.stringify({
      v: 1,
      broker_route_id: scope.brokerRouteId,
      failure_code: failureCode,
      channel_position_observation_id: channelPositionObservationId,
      requested_position: requestedPosition,
    }),
  );
}

/** One serialized route lane. Instances are dormant and can only be reached by direct module import. */
export class DormantA1IngressRouteActor {
  #database: DormantIngressDatabase;
  readonly #reopenDatabase: () => DormantIngressDatabase;
  readonly #scope: BrokerRouteActorScope;
  readonly #fence: CoordinatorLeaseFence;
  readonly #actorClaimToken: A1SafeId;
  readonly #evidenceReader: InternalA1BrokerEvidenceReader;
  readonly #resolvePlaneKey: A1IngressPlaneKeyResolver;
  readonly #openPart: A1IngressPartOpener | undefined;
  readonly #allocateOperationId: () => A1SafeId;
  readonly #nowMs: () => number;
  #actor: IngressRouteActorRecord | null = null;
  #running = false;

  constructor(options: DormantA1IngressRouteActorOptions) {
    if (options.scope.collaborationServerId !== options.fence.collaborationServerId) {
      throw new TypeError(
        "A1 ingress actor scope and coordinator fence belong to different servers",
      );
    }
    this.#database = options.database;
    this.#reopenDatabase = options.reopenDatabase;
    this.#scope = options.scope;
    this.#fence = options.fence;
    this.#actorClaimToken = options.actorClaimToken;
    this.#evidenceReader = options.evidenceReader;
    this.#resolvePlaneKey = options.resolvePlaneKey;
    this.#openPart = options.openPart;
    this.#allocateOperationId = options.allocateOperationId ?? defaultOperationId;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  get database(): DormantIngressDatabase {
    return this.#database;
  }

  #operationId(): A1SafeId {
    return parseA1SafeId(this.#allocateOperationId(), "ingress.operationId");
  }

  #observedAtMs(): number {
    const value = this.#nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("A1 ingress actor clock must return a non-negative safe integer");
    }
    // Durable route time never moves backward. The repository still checks that this clamped value
    // lies inside the current coordinator lease, so a rollback cannot extend authority.
    return Math.max(value, this.#actor?.updatedAtMs ?? 0);
  }

  #coordinate(operationId: A1SafeId, observedAtMs = this.#observedAtMs()) {
    if (this.#actor === null) throw new Error("A1 ingress route actor is not claimed");
    return Object.freeze({
      scope: this.#scope,
      fence: this.#fence,
      actorClaimToken: this.#actorClaimToken,
      expectedActorRevision: this.#actor.revision,
      operationId,
      observedAtMs,
    });
  }

  #adopt(result: IngressMutationResult): IngressMutationResult {
    this.#actor = result.actor;
    return result;
  }

  #reopenAfterUnknownCommit(): void {
    this.#database.close();
    this.#database = this.#reopenDatabase();
  }

  #claim(): IngressMutationResult {
    const initial = this.#database.ingress.readRouteHead(this.#scope.brokerRouteId);
    const operationId = this.#operationId();
    const request = Object.freeze({
      scope: this.#scope,
      fence: this.#fence,
      claimToken: this.#actorClaimToken,
      expectedActorRevision: initial?.actor.revision ?? 0,
      operationId,
      observedAtMs: Math.max(this.#observedAtMs(), initial?.actor.updatedAtMs ?? 0),
    });
    try {
      return this.#adopt(this.#database.ingress.claimRouteActor(request));
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcileRouteActorClaim(request);
      if (landed !== null) return this.#adopt(landed);
      return this.#adopt(this.#database.ingress.claimRouteActor(request));
    }
  }

  #putArtifact(
    transaction: DormantIngressTransaction,
    schemaId: string,
    digest: A1Digest,
    bytes: Uint8Array,
  ): ProtectedHandleId {
    const snapshot = ProtectedByteSnapshot.from(bytes);
    try {
      return transaction.putArtifact({
        ...artifactScope(this.#scope),
        artifactSchemaId: schemaId,
        artifactDigest: digest,
        artifactBytes: snapshot,
      }).artifactRef.protectedHandleId;
    } finally {
      snapshot.destroy();
    }
  }

  #stagePreparedPage(
    prepared: PreparedIngressEvidencePage,
    operationId: A1SafeId,
    observedAtMs: number,
  ): IngressMutationResult {
    let request: StageIngressReadPageRequest | null = null;
    const attempt = () =>
      this.#database.transaction((transaction) => {
        const pageEvidenceRef = this.#putArtifact(
          transaction,
          A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
          prepared.pageEvidenceDigest,
          prepared.pageEvidenceBytes,
        );
        const frames = prepared.frames.map((frame) => ({
          cursor: frame.cursor,
          channelPositionObservationId: frame.channelPositionObservationId,
          claimedDeliveryAttemptId: parseA1SafeId(frame.claimedDeliveryAttemptId),
          claimedPart: frame.claimedPart,
          claimedTransportFrameDigest: frame.claimedTransportFrameDigest,
          receivedFrameRef: this.#putArtifact(
            transaction,
            A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
            frame.rawFrameDigest,
            frame.rawFrameBytes,
          ),
          receivedFrameDigest: frame.rawFrameDigest,
          receivedFrameByteLength: frame.rawFrameBytes.byteLength,
        }));
        request = Object.freeze({
          ...this.#coordinate(operationId, observedAtMs),
          requestedPosition: prepared.page.requestedPosition,
          generation: prepared.page.generation,
          observedNextFrameIndex: prepared.page.observedNextFrameIndex,
          frames: Object.freeze(frames),
          nextPosition: prepared.page.nextPosition,
          atLiveTail: prepared.page.atLiveTail,
          pageEvidenceRef,
          pageEvidenceDigest: prepared.pageEvidenceDigest,
        });
        return transaction.ingress.stageReadPage(request);
      });
    try {
      return this.#adopt(attempt());
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError) || request === null) throw error;
      const captured = request as StageIngressReadPageRequest;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcileStageReadPage(captured);
      if (landed !== null) return this.#adopt(landed);
      // Proved absent: exact evidence bytes may be stored again under fresh random artifact refs.
      return this.#adopt(attempt());
    }
  }

  #latchOuterPageGap(
    requestedPosition: BrokerReadPositionV1,
    failureCode: A1SafeId,
  ): IngressMutationResult {
    const operationId = this.#operationId();
    const observedAtMs = this.#observedAtMs();
    const bytes = gapEvidenceBytes(this.#scope, failureCode, null, requestedPosition);
    const digest = sha256Digest(bytes);
    let request: Parameters<IngressRepositoryOperations["latchOuterPageGap"]>[0] | null = null;
    const attempt = () =>
      this.#database.transaction((transaction) => {
        const evidenceRef = this.#putArtifact(
          transaction,
          A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
          digest,
          bytes,
        );
        request = Object.freeze({
          ...this.#coordinate(operationId, observedAtMs),
          evidenceRef,
          evidenceDigest: digest,
          failureCode,
        });
        return transaction.ingress.latchOuterPageGap(request);
      });
    try {
      return this.#adopt(attempt());
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError) || request === null) throw error;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcileOuterPageGap(request);
      if (landed !== null) return this.#adopt(landed);
      return this.#adopt(attempt());
    }
  }

  #latchStorageQuotaGap(): IngressMutationResult {
    const operationId = this.#operationId();
    const observedAtMs = this.#observedAtMs();
    const bytes = gapEvidenceBytes(this.#scope, safeCode("storage_quota"), null, null);
    const digest = sha256Digest(bytes);
    let request: LatchIngressStorageQuotaGapRequest | null = null;
    const attempt = () =>
      this.#database.transaction((transaction) => {
        const evidenceRef = this.#putArtifact(
          transaction,
          A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
          digest,
          bytes,
        );
        request = Object.freeze({
          ...this.#coordinate(operationId, observedAtMs),
          evidenceRef,
          evidenceDigest: digest,
        });
        return transaction.ingress.latchStorageQuotaGap(request);
      });
    try {
      return this.#adopt(attempt());
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError) || request === null) throw error;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcileStorageQuotaGap(request);
      if (landed !== null) return this.#adopt(landed);
      return this.#adopt(attempt());
    }
  }

  #readRawFrame(pending: PendingIngressPosition): Uint8Array {
    return this.#database.transaction((transaction) => {
      const verified = transaction.readVerifiedArtifact({
        ...artifactScope(this.#scope),
        artifactRef: artifactRef(pending.receivedFrameRef),
        artifactSchemaId: A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
        expectedArtifactDigest: pending.receivedFrameDigest,
      });
      let bytes: Uint8Array;
      try {
        bytes = verified.artifactBytes.copyBytes();
      } finally {
        verified.artifactBytes.destroy();
      }
      if (bytes.byteLength !== pending.receivedFrameByteLength) {
        throw new Error("verified A1 ingress raw-frame artifact changed byte length");
      }
      return bytes;
    });
  }

  #classifyInvalid(
    result: Extract<InspectedPendingIngressFrame, { classification: "invalid" }>,
    operationId: A1SafeId,
    observedAtMs: number,
    pending: PendingIngressPosition,
  ): IngressMutationResult {
    const evidenceBytes = gapEvidenceBytes(
      this.#scope,
      result.validationFailureCode,
      pending.channelPositionObservationId,
      null,
    );
    const evidenceDigest = sha256Digest(evidenceBytes);
    let request: ClassifyInvalidIngressPositionRequest | null = null;
    const attempt = () =>
      this.#database.transaction((transaction) => {
        const gapEvidenceRef = this.#putArtifact(
          transaction,
          A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
          evidenceDigest,
          evidenceBytes,
        );
        request = Object.freeze({
          ...this.#coordinate(operationId, observedAtMs),
          channelPositionObservationId: pending.channelPositionObservationId,
          parsed: result.parsed,
          validationFailureCode: result.validationFailureCode,
          gapEvidenceRef,
          gapEvidenceDigest: evidenceDigest,
        });
        return transaction.ingress.classifyInvalidPosition(request);
      });
    try {
      return this.#adopt(attempt());
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError) || request === null) throw error;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcilePositionClassification(request);
      if (landed !== null) return this.#adopt(landed);
      return this.#adopt(attempt());
    }
  }

  #classifyUnknownOutbound(
    result: Extract<InspectedPendingIngressFrame, { classification: "unknown_outbound" }>,
    operationId: A1SafeId,
    observedAtMs: number,
    pending: PendingIngressPosition,
  ): IngressMutationResult {
    const code = safeCode("unknown_outbound");
    const evidenceBytes = gapEvidenceBytes(
      this.#scope,
      code,
      pending.channelPositionObservationId,
      null,
    );
    const evidenceDigest = sha256Digest(evidenceBytes);
    let request: ClassifyUnknownOutboundPositionRequest | null = null;
    const attempt = () =>
      this.#database.transaction((transaction) => {
        const gapEvidenceRef = this.#putArtifact(
          transaction,
          A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
          evidenceDigest,
          evidenceBytes,
        );
        request = Object.freeze({
          ...this.#coordinate(operationId, observedAtMs),
          parsed: result.parsed,
          gapEvidenceRef,
          gapEvidenceDigest: evidenceDigest,
        });
        return transaction.ingress.classifyUnknownOutboundPosition(request);
      });
    try {
      return this.#adopt(attempt());
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError) || request === null) throw error;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcilePositionClassification(request);
      if (landed !== null) return this.#adopt(landed);
      return this.#adopt(attempt());
    }
  }

  #classifyInbound(
    result: Extract<InspectedPendingIngressFrame, { classification: "inbound_ingress" }>,
    operationId: A1SafeId,
    observedAtMs: number,
  ): IngressPartClassificationResult {
    let request: ClassifyInboundPartRequest | null = null;
    const attempt = () =>
      this.#database.transaction((transaction) => {
        const plaintextPartRef = this.#putArtifact(
          transaction,
          A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID,
          result.plaintextPartDigest,
          result.plaintextPart,
        );
        request = Object.freeze({
          ...this.#coordinate(operationId, observedAtMs),
          parsed: result.parsed,
          sourceEventNamespaceId: result.sourceEventNamespaceId,
          stableSemanticResultId: result.stableSemanticResultId,
          ingressObservationId: result.ingressObservationId,
          plaintextPartRef,
          plaintextPartDigest: result.plaintextPartDigest,
          plaintextPartByteLength: result.plaintextPart.byteLength,
          authenticatedPartDigest: result.authenticatedPartDigest,
        });
        return transaction.ingress.classifyInboundPart(request);
      });
    try {
      return this.#adopt(attempt()) as IngressPartClassificationResult;
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError) || request === null) throw error;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcilePositionClassification(request);
      if (landed !== null) {
        this.#adopt(landed);
        const classification = this.#database.ingress.readPositionClassification(
          this.#scope.brokerRouteId,
          result.ingressObservationId,
        );
        if (
          classification === null ||
          classification.stableSemanticResultId !== result.stableSemanticResultId
        ) {
          throw new Error("reconciled A1 ingress classification is missing its durable result");
        }
        return Object.freeze({ ...landed, ...classification });
      }
      return this.#adopt(attempt()) as IngressPartClassificationResult;
    } finally {
      // The protected snapshot retained by SQLite owns the durable copy; erase this transient copy.
      result.plaintextPart.fill(0);
    }
  }

  async #processPending(): Promise<Readonly<{ processed: number; awaitingOrder: number }>> {
    let processed = 0;
    let awaitingOrder = 0;
    for (;;) {
      const pending = this.#database.ingress.readPendingPositions(
        this.#scope.brokerRouteId,
        DORMANT_A1_INGRESS_PENDING_BATCH,
      )[0];
      if (pending === undefined) break;
      const rawFrameBytes = this.#readRawFrame(pending);
      let inspected: InspectedPendingIngressFrame;
      try {
        inspected = await inspectPendingIngressFrame({
          machineIdentityId: this.#database.machineIdentityId,
          scope: this.#scope,
          pending,
          rawFrameBytes,
          resolvePlaneKey: this.#resolvePlaneKey,
          ...(this.#openPart === undefined ? {} : { openPart: this.#openPart }),
          claimedDeliveryAttemptId: pending.claimedDeliveryAttemptId,
          claimedPart: pending.claimedPart,
          claimedTransportFrameDigest: pending.claimedTransportFrameDigest,
        });
      } finally {
        rawFrameBytes.fill(0);
      }
      try {
        const operationId = this.#operationId();
        const observedAtMs = this.#observedAtMs();
        if (inspected.classification === "invalid") {
          this.#classifyInvalid(inspected, operationId, observedAtMs, pending);
        } else if (inspected.classification === "unknown_outbound") {
          this.#classifyUnknownOutbound(inspected, operationId, observedAtMs, pending);
        } else {
          let classified: IngressPartClassificationResult;
          try {
            classified = this.#classifyInbound(inspected, operationId, observedAtMs);
          } catch (error) {
            if (!(error instanceof IngressRepositoryQuotaError)) throw error;
            // The classification transaction (including its plaintext artifact) rolled back in full.
            // Retain one bounded route gap and stop polling/reprocessing this durable head.
            this.#latchStorageQuotaGap();
            break;
          }
          if (classified.resultState === "awaiting_order") awaitingOrder++;
        }
      } finally {
        if (inspected.classification === "inbound_ingress") inspected.plaintextPart.fill(0);
      }
      processed++;
    }
    return Object.freeze({ processed, awaitingOrder });
  }

  #recomputeSemanticCursor(): void {
    const operationId = this.#operationId();
    const request = this.#coordinate(operationId);
    try {
      this.#adopt(this.#database.ingress.recomputeSemanticCursor(request));
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcileSemanticCursorRecompute(request);
      if (landed !== null) {
        this.#adopt(landed);
        return;
      }
      this.#adopt(this.#database.ingress.recomputeSemanticCursor(request));
    }
  }

  #expireDueResults(): number {
    let expired = 0;
    for (;;) {
      const now = this.#observedAtMs();
      const due = this.#database.ingress.readNextDueAssemblingResult(
        this.#scope.brokerRouteId,
        now,
      );
      if (due === null) break;
      const request: ExpireIngressResultRequest = Object.freeze({
        ...this.#coordinate(this.#operationId(), now),
        stableSemanticResultId: due.stableSemanticResultId,
        expectedAssemblyDeadlineMs: due.assemblyDeadlineMs,
      });
      try {
        this.#adopt(this.#database.ingress.expireResult(request));
      } catch (error) {
        if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
        this.#reopenAfterUnknownCommit();
        const landed = this.#database.ingress.reconcileResultExpiry(request);
        if (landed !== null) {
          this.#adopt(landed);
        } else {
          this.#adopt(this.#database.ingress.expireResult(request));
        }
      }
      expired++;
    }
    return expired;
  }

  /** Release this route lane under the same exact claim/fence, with unknown-COMMIT reconciliation. */
  release(): IngressMutationResult {
    if (this.#running) throw new Error("cannot release an A1 ingress actor during a route cycle");
    if (this.#actor === null) throw new Error("A1 ingress route actor is not claimed");
    const request = this.#coordinate(this.#operationId());
    try {
      return this.#adopt(this.#database.ingress.releaseRouteActor(request));
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      this.#reopenAfterUnknownCommit();
      const landed = this.#database.ingress.reconcileRouteActorRelease(request);
      if (landed !== null) return this.#adopt(landed);
      return this.#adopt(this.#database.ingress.releaseRouteActor(request));
    }
  }

  /**
   * Claim, fetch exactly one page, atomically stage it, then recover every pending staged position.
   * Fetch may advance independently while semantic order remains blocked by an earlier candidate.
   */
  async runCycle(): Promise<DormantIngressRouteCycleResult> {
    if (this.#running) throw new Error("A1 ingress route actor is already running");
    this.#running = true;
    try {
      this.#claim();
      this.#expireDueResults();
      const admission = this.#database.ingress.readRouteHead(this.#scope.brokerRouteId);
      if (admission === null) throw new Error("claimed A1 ingress route has no durable state");
      if (admission.runtime.state === "closed" || admission.hasOpenStorageQuotaGap) {
        this.#recomputeSemanticCursor();
        return Object.freeze({
          fetched: false,
          stagedFrames: 0,
          processedPositions: 0,
          awaitingOrder: 0,
          atLiveTail: false,
        });
      }
      // A prior process may have committed the outer evidence page and died before classification.
      // Recover that durable work before relying on broker availability for a new page.
      const recovered = await this.#processPending();
      const before = this.#database.ingress.readRouteHead(this.#scope.brokerRouteId);
      if (before === null) throw new Error("claimed A1 ingress route has no durable state");
      if (before.runtime.state !== "current" || before.hasOpenStorageQuotaGap) {
        this.#recomputeSemanticCursor();
        return Object.freeze({
          fetched: false,
          stagedFrames: 0,
          processedPositions: recovered.processed,
          awaitingOrder: recovered.awaitingOrder,
          atLiveTail: false,
        });
      }
      const position: BrokerReadPositionV1 = Object.freeze({
        version: 1,
        channelGeneration: before.fetchCursor.nextGeneration,
        nextFrameIndex: before.fetchCursor.nextFrameIndex,
      });
      let page: InternalA1BrokerReadEvidencePageV1;
      try {
        page = await readIngressEvidencePage(this.#evidenceReader, position);
      } catch (error) {
        if (error instanceof A1BrokerOutcomeUnknownError) {
          this.#recomputeSemanticCursor();
          return Object.freeze({
            fetched: false,
            stagedFrames: 0,
            processedPositions: recovered.processed,
            awaitingOrder: recovered.awaitingOrder,
            atLiveTail: false,
          });
        }
        if (
          error instanceof A1BrokerHttpError &&
          [
            "route_not_found",
            "route_store_mismatch",
            "route_auth_mismatch",
            "broker_capabilities_mismatch",
            "generation_mismatch",
            "invalid_read_position",
          ].includes(error.code)
        ) {
          this.#latchOuterPageGap(position, safeCode(error.code));
          this.#recomputeSemanticCursor();
          return Object.freeze({
            fetched: false,
            stagedFrames: 0,
            processedPositions: recovered.processed,
            awaitingOrder: recovered.awaitingOrder,
            atLiveTail: false,
          });
        }
        if (!(error instanceof A1BrokerProtocolError)) throw error;
        this.#latchOuterPageGap(position, safeCode("outer_page_invalid"));
        this.#recomputeSemanticCursor();
        return Object.freeze({
          fetched: false,
          stagedFrames: 0,
          processedPositions: recovered.processed,
          awaitingOrder: recovered.awaitingOrder,
          atLiveTail: false,
        });
      }
      if (!pageMatchesRequestedPosition(page, position)) {
        this.#latchOuterPageGap(position, safeCode("outer_page_invalid"));
        this.#recomputeSemanticCursor();
        return Object.freeze({
          fetched: false,
          stagedFrames: 0,
          processedPositions: recovered.processed,
          awaitingOrder: recovered.awaitingOrder,
          atLiveTail: false,
        });
      }
      let prepared: PreparedIngressEvidencePage;
      try {
        prepared = await prepareIngressEvidencePage(this.#scope.brokerRouteId, page);
      } catch {
        this.#latchOuterPageGap(position, safeCode("outer_page_invalid"));
        this.#recomputeSemanticCursor();
        return Object.freeze({
          fetched: false,
          stagedFrames: 0,
          processedPositions: recovered.processed,
          awaitingOrder: recovered.awaitingOrder,
          atLiveTail: false,
        });
      }
      if (prepared.page.routeStoreInstanceId !== before.routeStoreInstanceId) {
        prepared.pageEvidenceBytes.fill(0);
        for (const frame of prepared.frames) frame.rawFrameBytes.fill(0);
        this.#latchOuterPageGap(position, safeCode("route_store_mismatch"));
        this.#recomputeSemanticCursor();
        return Object.freeze({
          fetched: false,
          stagedFrames: 0,
          processedPositions: recovered.processed,
          awaitingOrder: recovered.awaitingOrder,
          atLiveTail: false,
        });
      }
      if (isExactRetainedOpenTail(before, prepared)) {
        prepared.pageEvidenceBytes.fill(0);
        this.#expireDueResults();
        this.#recomputeSemanticCursor();
        return Object.freeze({
          fetched: true,
          stagedFrames: 0,
          processedPositions: recovered.processed,
          awaitingOrder: recovered.awaitingOrder,
          atLiveTail: true,
        });
      }
      try {
        try {
          this.#stagePreparedPage(prepared, this.#operationId(), this.#observedAtMs());
        } catch (error) {
          if (!(error instanceof IngressRepositoryQuotaError)) throw error;
          // The page transaction rolled back in full: latch only bounded local evidence. The fetch
          // cursor remains unchanged, and the open quota gap suppresses all later polling.
          this.#latchStorageQuotaGap();
          this.#recomputeSemanticCursor();
          return Object.freeze({
            fetched: false,
            stagedFrames: 0,
            processedPositions: recovered.processed,
            awaitingOrder: recovered.awaitingOrder,
            atLiveTail: false,
          });
        }
      } finally {
        // putArtifact synchronously snapshots each value into fixed storage before returning.
        // Unknown-COMMIT reconciliation/retry has also completed before these transient bodies die.
        prepared.pageEvidenceBytes.fill(0);
        for (const frame of prepared.frames) frame.rawFrameBytes.fill(0);
      }
      const processed = await this.#processPending();
      this.#expireDueResults();
      this.#recomputeSemanticCursor();
      return Object.freeze({
        fetched: true,
        stagedFrames: prepared.frames.length,
        processedPositions: recovered.processed + processed.processed,
        awaitingOrder: recovered.awaitingOrder + processed.awaitingOrder,
        atLiveTail: prepared.page.atLiveTail,
      });
    } finally {
      this.#running = false;
    }
  }
}

/** Convenience constructor kept direct-module-only with the dormant actor. */
export function createDormantA1IngressRouteActor(
  options: DormantA1IngressRouteActorOptions,
): DormantA1IngressRouteActor {
  return new DormantA1IngressRouteActor(options);
}
