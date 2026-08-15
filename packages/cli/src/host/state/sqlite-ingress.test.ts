import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type A1EncryptedFrameV2,
  type A1FrameHeaderV2,
  a1AuthenticatedPartDigest,
  base64urlEncode,
  deriveA1ChannelPositionObservationId,
  deriveA1IngressObservationId,
  deriveA1StableSemanticResultId,
  deriveA1WebSourceNamespaceId,
  encodeA1EncryptedFrameV2Bytes,
  normalizedA1TransportFrameBytes,
} from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  type A1CanonicalId,
  type A1CanonicalIdKind,
  HostStateContractError,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "./ids.js";
import {
  A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
  A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID,
  A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
  A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
  type BrokerRouteActorScope,
  type IngressMutationResult,
  IngressRepositoryQuotaError,
  IngressRepositoryStaleCoordinatorError,
} from "./ingress-repository.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  type HostStateDatabase,
  type HostStateTransaction,
  openHostStateDatabase,
  type TerminalRegistrationInput,
} from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "84".repeat(16);
const IDENTITY_BYTES = Uint8Array.from(Buffer.from(MACHINE_IDENTITY_ID, "hex"));
const NOW_MS = 20_000;
const ROUTE_STORE_INSTANCE_ID = parseBrokerRouteStoreInstanceId(
  `rbsi_${base64urlEncode(new Uint8Array(16).fill(91))}`,
);
const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];

function digestBytes(bytes: Uint8Array) {
  return parseA1Digest(createHash("sha256").update(bytes).digest("base64url"));
}

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

function registration(fill: number): TerminalRegistrationInput {
  return {
    registrationAttemptId: canonicalId("registrationAttempt", fill),
    descriptor: { product: "codex", access: "app-server" },
    descriptorRef: parseA1SafeId(`descriptor-${fill}`),
    descriptorDigest: digestBytes(new Uint8Array([fill, 1])),
    projectRef: parseA1SafeId(`project-${fill}`),
    projectDigest: digestBytes(new Uint8Array([fill, 2])),
    expectedNativeRefDigest: null,
    initialPhase: "starting",
    metadataSchemaId: "remote-claw/sqlite-ingress-test/v1",
    metadataRef: parseA1SafeId(`metadata-${fill}`),
    metadataDigest: digestBytes(new Uint8Array([fill, 3])),
    capabilitiesRef: null,
    capabilitiesDigest: null,
  };
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a17-sqlite-ingress-"),
  );
  temporaryRoots.push(root);
  const environment = {
    xdgStateHome: join(root, "state"),
    homeDirectory: join(root, "home"),
  };
  return { environment, paths: resolveHostStatePaths(MACHINE_IDENTITY_ID, environment) };
}

function routeRequest(
  serverId: A1CanonicalId<"collaborationServer">,
  chatId: A1CanonicalId<"logicalChat">,
  coordinatorLeaseId: A1CanonicalId<"coordinatorLease">,
  artifactRef: A1CanonicalId<"protectedHandle">,
  routeStoreInstanceId = ROUTE_STORE_INSTANCE_ID,
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
        routeStoreInstanceId,
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

interface IngressHarness {
  readonly database: HostStateDatabase;
  readonly scope: BrokerRouteActorScope;
  readonly fence: {
    readonly collaborationServerId: A1CanonicalId<"collaborationServer">;
    readonly coordinatorLeaseId: A1CanonicalId<"coordinatorLease">;
    readonly coordinatorEpoch: number;
  };
  readonly serverId: A1CanonicalId<"collaborationServer">;
  readonly routeId: ReturnType<typeof deriveBrokerRouteId>;
  readonly routeStoreInstanceId: ReturnType<typeof parseBrokerRouteStoreInstanceId>;
  readonly capabilityArtifactRef: A1CanonicalId<"protectedHandle">;
  readonly chatId: A1CanonicalId<"logicalChat">;
  claimToken: ReturnType<typeof parseA1SafeId>;
  actorRevision: number;
}

function installHarness(database: HostStateDatabase): IngressHarness {
  const server = database.records.ensureDefaultCollaborationServer().server;
  const acquisition = database.records.acquireCoordinatorLease({
    collaborationServerId: server.collaborationServerId,
    candidateLeaseId: canonicalId("coordinatorLease", 41),
    ownerInstanceId: parseA1SafeId("a17-ingress-owner"),
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
    workspaceSelectorId: parseA1SafeId("a17-workspace"),
    terminalTarget: {
      kind: "terminal_native",
      descriptor: { product: "codex", access: "app-server" },
      terminalProjectRef: parseA1SafeId("a17-terminal-project"),
      nativeWorkspaceBindingId: null,
    },
    mappingEvidenceRef: parseA1SafeId("a17-mapping-evidence"),
    registration: registration(51),
  }).chat;
  const capabilityBytes = canonicalBrokerBackendCapabilitiesV1(
    REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
  );
  const capabilityDigest = syncBrokerBackendCapabilitiesDigestV1(
    REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
  );
  const installation = database.transaction((transaction) => {
    const artifact = transaction.putArtifact({
      scopeKind: "host_profile",
      scopeId: "default",
      artifactSchemaId: BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
      artifactDigest: capabilityDigest,
      artifactBytes: ProtectedByteSnapshot.from(capabilityBytes),
    });
    return {
      installed: transaction.brokerRoute.install(
        routeRequest(
          server.collaborationServerId,
          chat.logicalChatId,
          acquisition.lease.coordinatorLeaseId,
          artifact.artifactRef.protectedHandleId,
        ),
      ),
      capabilityArtifactRef: artifact.artifactRef.protectedHandleId,
    };
  });
  const installed = installation.installed;
  const routeId = installed.route.brokerRouteId;
  const scope = {
    brokerRouteId: routeId,
    collaborationServerId: server.collaborationServerId,
    routeKind: "chat" as const,
    logicalChatId: chat.logicalChatId,
  };
  const claimToken = parseA1SafeId("actor-claim-1");
  const claim = database.ingress.claimRouteActor({
    scope,
    fence,
    claimToken,
    expectedActorRevision: 0,
    operationId: parseA1SafeId("op-claim-1"),
    observedAtMs: NOW_MS,
  });
  return {
    database,
    scope,
    fence,
    serverId: server.collaborationServerId,
    routeId,
    routeStoreInstanceId: ROUTE_STORE_INSTANCE_ID,
    capabilityArtifactRef: installation.capabilityArtifactRef,
    chatId: chat.logicalChatId,
    claimToken,
    actorRevision: claim.actor.revision,
  };
}

function installAdditionalHarness(
  database: HostStateDatabase,
  first: IngressHarness,
): IngressHarness {
  const project = database.records.listProjects(first.serverId)[0];
  if (project === undefined) throw new Error("missing first ingress project");
  const mapping = database.records.listProjectTargetMappings(
    first.serverId,
    project.projectId,
    parseA1SafeId("a17-workspace"),
  )[0];
  if (mapping === undefined) throw new Error("missing first ingress project mapping");
  const chat = database.records.reserveAdditionalTerminalChat({
    fence: first.fence,
    mappingFence: {
      projectId: project.projectId,
      workspaceSelectorId: mapping.workspaceSelectorId,
      projectTargetSelectorMappingId: mapping.projectTargetSelectorMappingId,
      mappingGeneration: mapping.mappingGeneration,
      targetDigest: mapping.targetDigest,
    },
    parentChatId: null,
    registration: registration(52),
  }).chat;
  const routeStoreInstanceId = parseBrokerRouteStoreInstanceId(
    `rbsi_${base64urlEncode(new Uint8Array(16).fill(92))}`,
  );
  const installed = database.transaction((transaction) => {
    return transaction.brokerRoute.install(
      routeRequest(
        first.serverId,
        chat.logicalChatId,
        first.fence.coordinatorLeaseId,
        first.capabilityArtifactRef,
        routeStoreInstanceId,
      ),
    );
  });
  const scope = {
    brokerRouteId: installed.route.brokerRouteId,
    collaborationServerId: first.serverId,
    routeKind: "chat" as const,
    logicalChatId: chat.logicalChatId,
  };
  const claimToken = parseA1SafeId("actor-claim-2");
  const claim = database.ingress.claimRouteActor({
    scope,
    fence: first.fence,
    claimToken,
    expectedActorRevision: 0,
    operationId: parseA1SafeId("op-claim-2"),
    observedAtMs: NOW_MS,
  });
  return {
    database,
    scope,
    fence: first.fence,
    serverId: first.serverId,
    routeId: installed.route.brokerRouteId,
    routeStoreInstanceId,
    capabilityArtifactRef: first.capabilityArtifactRef,
    chatId: chat.logicalChatId,
    claimToken,
    actorRevision: claim.actor.revision,
  };
}

function coordinate(harness: IngressHarness, operation: string, observedAtMs = Date.now()) {
  return {
    scope: harness.scope,
    fence: harness.fence,
    actorClaimToken: harness.claimToken,
    expectedActorRevision: harness.actorRevision,
    operationId: parseA1SafeId(operation),
    observedAtMs,
  };
}

function recordMutation(harness: IngressHarness, result: IngressMutationResult) {
  harness.actorRevision = result.actor.revision;
  return result;
}

function attemptId(fill: number) {
  return parseA1SafeId(`rda_${base64urlEncode(new Uint8Array(16).fill(fill))}`);
}

function userHeader(
  harness: IngressHarness,
  fill: number,
  overrides: Partial<A1FrameHeaderV2> = {},
): A1FrameHeaderV2 {
  return {
    v: 2,
    identityId: IDENTITY_BYTES,
    collaborationServerId: harness.serverId,
    logicalChatId: harness.chatId,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: "source.msg-1",
    deliveryAttemptId: attemptId(fill),
    clientMsgId: "client:proposal-1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
    serverKeyGeneration: null,
    hostSignerIdentityKeyId: null,
    hostScopeCertificateId: null,
    hostSignatureSequence: null,
    ...overrides,
  };
}

function frameFor(header: A1FrameHeaderV2, fill: number): A1EncryptedFrameV2 {
  return {
    ...header,
    salt: new Uint8Array(32).fill(fill),
    nonce: new Uint8Array(12).fill(fill + 1),
    ct: new Uint8Array(16).fill(fill + 2),
    hostSignature: null,
  };
}

interface PreparedStagePageFrame {
  readonly frame: A1EncryptedFrameV2;
  readonly cursor: {
    readonly version: 1;
    readonly channelGeneration: 0;
    readonly frameIndex: number;
  };
  readonly positionId: ReturnType<typeof parseA1SafeId>;
  readonly rawBytes: Uint8Array;
  readonly rawDigest: ReturnType<typeof digestBytes>;
  readonly transportDigest: ReturnType<typeof digestBytes>;
}

interface PreparedStagePage {
  readonly startIndex: number;
  readonly frames: readonly PreparedStagePageFrame[];
  readonly requestedPosition: {
    readonly version: 1;
    readonly channelGeneration: 0;
    readonly nextFrameIndex: number;
  };
  readonly nextPosition: {
    readonly version: 1;
    readonly channelGeneration: 0;
    readonly nextFrameIndex: number;
  };
  readonly generation: {
    readonly schemaVersion: 1;
    readonly brokerRouteId: ReturnType<typeof deriveBrokerRouteId>;
    readonly channelGeneration: 0;
    readonly state: "open";
    readonly frameCount: null;
    readonly nextGeneration: null;
    readonly manifestDigest: null;
  };
  readonly pageBytes: Uint8Array;
  readonly pageDigest: ReturnType<typeof digestBytes>;
  readonly observedNextFrameIndex: number;
  readonly atLiveTail: boolean;
}

async function prepareStagePage(
  harness: IngressHarness,
  frames: readonly A1EncryptedFrameV2[],
  startIndex: number,
  observedNextFrameIndex = startIndex + frames.length,
): Promise<PreparedStagePage> {
  const preparedFrames = await Promise.all(
    frames.map(async (frame, offset): Promise<PreparedStagePageFrame> => {
      const cursor = {
        version: 1 as const,
        channelGeneration: 0 as const,
        frameIndex: startIndex + offset,
      };
      const rawBytes = encodeA1EncryptedFrameV2Bytes(frame);
      return {
        frame,
        cursor,
        positionId: parseA1SafeId(
          await deriveA1ChannelPositionObservationId(harness.routeId, cursor),
        ),
        rawBytes,
        rawDigest: digestBytes(rawBytes),
        transportDigest: digestBytes(normalizedA1TransportFrameBytes(frame)),
      };
    }),
  );
  const requestedPosition = {
    version: 1 as const,
    channelGeneration: 0 as const,
    nextFrameIndex: startIndex,
  };
  const nextPosition = {
    version: 1 as const,
    channelGeneration: 0 as const,
    nextFrameIndex: startIndex + frames.length,
  };
  const generation = {
    schemaVersion: 1 as const,
    brokerRouteId: harness.routeId,
    channelGeneration: 0 as const,
    state: "open" as const,
    frameCount: null,
    nextGeneration: null,
    manifestDigest: null,
  };
  const atLiveTail = nextPosition.nextFrameIndex === observedNextFrameIndex;
  const pageBytes = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      broker_route_id: harness.routeId,
      route_store_instance_id: harness.routeStoreInstanceId,
      requested_position: requestedPosition,
      generation,
      observed_next_frame_index: observedNextFrameIndex,
      frames: preparedFrames.map((prepared) => ({
        cursor: prepared.cursor,
        delivery_attempt_id: prepared.frame.deliveryAttemptId,
        part: prepared.frame.part,
        transport_frame_digest: prepared.transportDigest,
        raw_frame_digest: prepared.rawDigest,
      })),
      next_position: nextPosition,
      at_live_tail: atLiveTail,
    }),
  );
  return {
    startIndex,
    frames: preparedFrames,
    requestedPosition,
    nextPosition,
    generation,
    pageBytes,
    pageDigest: digestBytes(pageBytes),
    observedNextFrameIndex,
    atLiveTail,
  };
}

function stagePage(
  harness: IngressHarness,
  transaction: HostStateTransaction,
  prepared: PreparedStagePage,
  operationId: string,
) {
  const artifacts = prepared.frames.map((frame) =>
    transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: harness.serverId,
      artifactSchemaId: A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
      artifactDigest: frame.rawDigest,
      artifactBytes: ProtectedByteSnapshot.from(frame.rawBytes),
    }),
  );
  const page = transaction.putArtifact({
    scopeKind: "collaboration_server",
    scopeId: harness.serverId,
    artifactSchemaId: A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
    artifactDigest: prepared.pageDigest,
    artifactBytes: ProtectedByteSnapshot.from(prepared.pageBytes),
  });
  const result = transaction.ingress.stageReadPage({
    ...coordinate(harness, operationId),
    requestedPosition: prepared.requestedPosition,
    generation: prepared.generation,
    observedNextFrameIndex: prepared.observedNextFrameIndex,
    frames: prepared.frames.map((frame, index) => ({
      cursor: frame.cursor,
      channelPositionObservationId: frame.positionId,
      claimedDeliveryAttemptId: parseA1SafeId(frame.frame.deliveryAttemptId),
      claimedPart: frame.frame.part,
      claimedTransportFrameDigest: frame.transportDigest,
      receivedFrameRef:
        artifacts[index]?.artifactRef.protectedHandleId ??
        (() => {
          throw new Error("missing staged raw artifact");
        })(),
      receivedFrameDigest: frame.rawDigest,
      receivedFrameByteLength: frame.rawBytes.byteLength,
    })),
    nextPosition: prepared.nextPosition,
    atLiveTail: prepared.atLiveTail,
    pageEvidenceRef: page.artifactRef.protectedHandleId,
    pageEvidenceDigest: prepared.pageDigest,
  });
  return recordMutation(harness, result);
}

async function prepareStageFrame(
  harness: IngressHarness,
  frame: A1EncryptedFrameV2,
  frameIndex: number,
) {
  const cursor = { version: 1 as const, channelGeneration: 0, frameIndex };
  const rawBytes = encodeA1EncryptedFrameV2Bytes(frame);
  const rawDigest = digestBytes(rawBytes);
  const transportDigest = digestBytes(normalizedA1TransportFrameBytes(frame));
  const positionId = parseA1SafeId(
    await deriveA1ChannelPositionObservationId(harness.routeId, cursor),
  );
  const requestedPosition = {
    version: 1 as const,
    channelGeneration: 0,
    nextFrameIndex: frameIndex,
  };
  const nextPosition = {
    version: 1 as const,
    channelGeneration: 0,
    nextFrameIndex: frameIndex + 1,
  };
  const generation = {
    schemaVersion: 1 as const,
    brokerRouteId: harness.routeId,
    channelGeneration: 0,
    state: "open" as const,
    frameCount: null,
    nextGeneration: null,
    manifestDigest: null,
  };
  const pageValue = {
    v: 1,
    broker_route_id: harness.routeId,
    route_store_instance_id: harness.routeStoreInstanceId,
    requested_position: requestedPosition,
    generation,
    observed_next_frame_index: frameIndex + 1,
    frames: [
      {
        cursor,
        delivery_attempt_id: frame.deliveryAttemptId,
        part: frame.part,
        transport_frame_digest: transportDigest,
        raw_frame_digest: rawDigest,
      },
    ],
    next_position: nextPosition,
    at_live_tail: true,
  };
  const pageBytes = new TextEncoder().encode(JSON.stringify(pageValue));
  const pageDigest = digestBytes(pageBytes);
  return {
    frame,
    frameIndex,
    cursor,
    positionId,
    rawBytes,
    rawDigest,
    transportDigest,
    requestedPosition,
    nextPosition,
    generation,
    pageBytes,
    pageDigest,
  };
}

function stageFrame(
  harness: IngressHarness,
  transaction: HostStateTransaction,
  prepared: Awaited<ReturnType<typeof prepareStageFrame>>,
  operationId: string,
  existingRawRef?: A1CanonicalId<"protectedHandle">,
) {
  const rawRef =
    existingRawRef ??
    transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: harness.serverId,
      artifactSchemaId: A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
      artifactDigest: prepared.rawDigest,
      artifactBytes: ProtectedByteSnapshot.from(prepared.rawBytes),
    }).artifactRef.protectedHandleId;
  const page = transaction.putArtifact({
    scopeKind: "collaboration_server",
    scopeId: harness.serverId,
    artifactSchemaId: A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
    artifactDigest: prepared.pageDigest,
    artifactBytes: ProtectedByteSnapshot.from(prepared.pageBytes),
  });
  const staged = transaction.ingress.stageReadPage({
    ...coordinate(harness, operationId),
    requestedPosition: prepared.requestedPosition,
    generation: prepared.generation,
    observedNextFrameIndex: prepared.frameIndex + 1,
    frames: [
      {
        cursor: prepared.cursor,
        channelPositionObservationId: prepared.positionId,
        claimedDeliveryAttemptId: parseA1SafeId(prepared.frame.deliveryAttemptId),
        claimedPart: prepared.frame.part,
        claimedTransportFrameDigest: prepared.transportDigest,
        receivedFrameRef: rawRef,
        receivedFrameDigest: prepared.rawDigest,
        receivedFrameByteLength: prepared.rawBytes.byteLength,
      },
    ],
    nextPosition: prepared.nextPosition,
    atLiveTail: true,
    pageEvidenceRef: page.artifactRef.protectedHandleId,
    pageEvidenceDigest: prepared.pageDigest,
  });
  recordMutation(harness, staged);
  return { positionId: prepared.positionId, transportDigest: prepared.transportDigest, rawRef };
}

async function prepareClassification(
  harness: IngressHarness,
  header: A1FrameHeaderV2,
  positionId: ReturnType<typeof parseA1SafeId>,
  transportDigest: ReturnType<typeof digestBytes>,
  plaintext: Uint8Array,
) {
  const route = {
    routeKind: "chat" as const,
    identityId: IDENTITY_BYTES,
    collaborationServerId: harness.serverId,
    logicalChatId: harness.chatId,
  };
  const namespaceId = parseA1SafeId(await deriveA1WebSourceNamespaceId(route));
  const resultId = parseA1SafeId(
    await deriveA1StableSemanticResultId(route, namespaceId, header.msgId),
  );
  const observationId = parseA1SafeId(await deriveA1IngressObservationId(positionId));
  const plaintextDigest = digestBytes(plaintext);
  const authenticatedPartDigest = parseA1Digest(await a1AuthenticatedPartDigest(header, plaintext));
  return {
    header,
    positionId,
    transportDigest,
    plaintext,
    namespaceId,
    resultId,
    observationId,
    plaintextDigest,
    authenticatedPartDigest,
  };
}

function classifyPart(
  harness: IngressHarness,
  transaction: HostStateTransaction,
  prepared: Awaited<ReturnType<typeof prepareClassification>>,
  operationId: string,
) {
  const evidence = transaction.putArtifact({
    scopeKind: "collaboration_server",
    scopeId: harness.serverId,
    artifactSchemaId: A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID,
    artifactDigest: prepared.plaintextDigest,
    artifactBytes: ProtectedByteSnapshot.from(prepared.plaintext),
  });
  const classified = transaction.ingress.classifyInboundPart({
    ...coordinate(harness, operationId),
    parsed: {
      channelPositionObservationId: prepared.positionId,
      normalizedTransportFrameDigest: prepared.transportDigest,
      header: prepared.header,
    },
    sourceEventNamespaceId: prepared.namespaceId,
    stableSemanticResultId: prepared.resultId,
    ingressObservationId: prepared.observationId,
    plaintextPartRef: evidence.artifactRef.protectedHandleId,
    plaintextPartDigest: prepared.plaintextDigest,
    plaintextPartByteLength: prepared.plaintext.byteLength,
    authenticatedPartDigest: prepared.authenticatedPartDigest,
  });
  recordMutation(harness, classified);
  return {
    classified,
    resultId: prepared.resultId,
    namespaceId: prepared.namespaceId,
    observationId: prepared.observationId,
  };
}

function recoverGap(
  harness: IngressHarness,
  gapId: ReturnType<typeof parseA1SafeId>,
  tag: string,
  decision: "discard_and_close_source" | "proved_safe_discard" = "proved_safe_discard",
) {
  const bytes = new TextEncoder().encode(`{"v":1,"recovery":"${tag}"}`);
  const evidenceDigest = digestBytes(bytes);
  return harness.database.transaction((transaction) => {
    const evidence = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: harness.serverId,
      artifactSchemaId: A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
      artifactDigest: evidenceDigest,
      artifactBytes: ProtectedByteSnapshot.from(bytes),
    });
    return recordMutation(
      harness,
      transaction.ingress.recoverGap({
        ...coordinate(harness, `op-recover-${tag}`),
        gapId,
        recoveryId: parseA1SafeId(`recovery-${tag}`),
        decision,
        evidenceRef: evidence.artifactRef.protectedHandleId,
        evidenceDigest,
      }),
    );
  });
}

function recomputeSemanticCursor(harness: IngressHarness, tag: string) {
  return recordMutation(
    harness,
    harness.database.ingress.recomputeSemanticCursor({
      ...coordinate(harness, `op-recompute-${tag}`),
    }),
  );
}

async function stageAndClassify(
  harness: IngressHarness,
  header: A1FrameHeaderV2,
  frame: A1EncryptedFrameV2,
  plaintext: Uint8Array,
  frameIndex: number,
  tag: string,
) {
  const preparedStage = await prepareStageFrame(harness, frame, frameIndex);
  const staged = harness.database.transaction((transaction) =>
    stageFrame(harness, transaction, preparedStage, `op-stage-${tag}`),
  );
  const preparedClassification = await prepareClassification(
    harness,
    header,
    staged.positionId,
    staged.transportDigest,
    plaintext,
  );
  return harness.database.transaction((transaction) =>
    classifyPart(harness, transaction, preparedClassification, `op-classify-${tag}`),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.7a real SQLite durable-ingress integration", () => {
  it("stages and authenticates one part, survives reopen, and installs no A1.8 surface", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 61);
    const frame = frameFor(header, 71);
    const plaintext = new TextEncoder().encode('{"v":1,"text":"hello"}');

    const preparedStage = await prepareStageFrame(harness, frame, 0);
    const staged = database.transaction((transaction) =>
      stageFrame(harness, transaction, preparedStage, "op-stage-one"),
    );
    const preparedClassification = await prepareClassification(
      harness,
      header,
      staged.positionId,
      staged.transportDigest,
      plaintext,
    );
    const completed = database.transaction((transaction) =>
      classifyPart(harness, transaction, preparedClassification, "op-classify-one"),
    );
    expect(completed.classified).toMatchObject({
      candidateState: "complete",
      resultState: "awaiting_order",
    });
    expect(database.ingress.readRouteState(harness.routeId)).toMatchObject({
      positions: [{ classification: "inbound_ingress", cursorDisposition: "advanceable" }],
      results: [{ state: "awaiting_order" }],
      candidates: [{ state: "complete", receivedParts: 1 }],
      parts: [{ part: 0 }],
      observations: [{ disposition: "new_part", cursorDisposition: "advanceable" }],
    });
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(reopened.schemaVersion).toBe(10);
    expect(reopened.ingress.readRouteState(harness.routeId)?.results).toMatchObject([
      { stableSemanticResultId: completed.resultId, state: "awaiting_order" },
    ]);
    reopened.close();

    const inspection = new DatabaseSync(state.paths.databasePath, { readOnly: true });
    try {
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

  it("assembles multipart ingress, advances every part, and classifies an exact retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const firstHeader = userHeader(harness, 62, {
      msgId: "source.multipart-1",
      clientMsgId: "client:multipart-1",
      part: 0,
      parts: 2,
    });
    const secondHeader = { ...firstHeader, part: 1 };
    const first = await stageAndClassify(
      harness,
      firstHeader,
      frameFor(firstHeader, 72),
      new TextEncoder().encode('{"v":1,"text":"hel'),
      0,
      "multipart-first",
    );
    expect(first.classified).toMatchObject({
      candidateState: "assembling",
      resultState: "assembling",
    });
    expect(database.ingress.readRouteState(harness.routeId)?.positions[0]).toMatchObject({
      cursorDisposition: "blocked",
    });

    const secondFrame = frameFor(secondHeader, 73);
    const second = await stageAndClassify(
      harness,
      secondHeader,
      secondFrame,
      new TextEncoder().encode('lo"}'),
      1,
      "multipart-second",
    );
    expect(second.classified).toMatchObject({
      candidateState: "complete",
      resultState: "awaiting_order",
    });

    const retry = await stageAndClassify(
      harness,
      secondHeader,
      secondFrame,
      new TextEncoder().encode('lo"}'),
      2,
      "multipart-retry",
    );
    expect(retry.classified).toMatchObject({
      candidateState: "complete",
      resultState: "awaiting_order",
    });
    const durable = database.ingress.readRouteState(harness.routeId);
    expect(durable?.positions.map((position) => position.cursorDisposition)).toEqual([
      "advanceable",
      "advanceable",
      "advanceable",
    ]);
    expect(durable?.observations.map((observation) => observation.disposition)).toEqual([
      "new_part",
      "new_part",
      "exact_transport_retry",
    ]);
    expect(durable?.parts).toHaveLength(2);
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(reopened.ingress.readRouteState(harness.routeId)?.results).toMatchObject([
      { stableSemanticResultId: second.resultId, state: "awaiting_order" },
    ]);
    reopened.close();
  });

  it("scrubs prior multipart plaintext when a later retained artifact fails verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const firstHeader = userHeader(harness, 137, {
      msgId: "source.multipart-fail-later-artifact",
      clientMsgId: "client:multipart-fail-later-artifact",
      part: 0,
      parts: 3,
    });
    const secondHeader = { ...firstHeader, part: 1 };
    const finalHeader = { ...firstHeader, part: 2 };
    const firstPlaintext = new TextEncoder().encode('{"v":1,"text":"scrub-prior-');
    const secondPlaintext = new TextEncoder().encode("corrupted-later-");

    await stageAndClassify(
      harness,
      firstHeader,
      frameFor(firstHeader, 137),
      firstPlaintext,
      0,
      "multipart-fail-later-first",
    );
    await stageAndClassify(
      harness,
      secondHeader,
      frameFor(secondHeader, 138),
      secondPlaintext,
      1,
      "multipart-fail-later-second",
    );
    const secondPartRef = database.ingress
      .readRouteState(harness.routeId)
      ?.parts.find((part) => part.part === 1)?.plaintextPartRef;
    if (secondPartRef === undefined) throw new Error("missing retained second multipart part");
    mutateIngressHeadWithoutTrigger(
      state.paths.databasePath,
      "protected_artifacts_no_update",
      (editor) => {
        editor
          .prepare("UPDATE protected_artifacts SET artifact_bytes=? WHERE protected_handle_id=?")
          .run(new Uint8Array(secondPlaintext.byteLength).fill(255), secondPartRef);
      },
    );

    const scrubbedPriorParts: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    vi.spyOn(Uint8Array.prototype, "fill").mockImplementation(function (
      this: Uint8Array,
      value,
      start,
      end,
    ) {
      const wasPriorPlaintext =
        this.byteLength === firstPlaintext.byteLength &&
        this.every((byte, index) => byte === firstPlaintext[index]);
      const filled = originalFill.call(this, value, start, end);
      if (wasPriorPlaintext) scrubbedPriorParts.push(this);
      return filled;
    });

    await expect(
      stageAndClassify(
        harness,
        finalHeader,
        frameFor(finalHeader, 139),
        new TextEncoder().encode('done"}'),
        2,
        "multipart-fail-later-final",
      ),
    ).rejects.toThrow(/ingress artifact could not be verified/);
    expect(scrubbedPriorParts.length).toBeGreaterThanOrEqual(2);
    for (const scrubbed of scrubbedPriorParts) {
      expect(scrubbed.every((byte) => byte === 0)).toBe(true);
    }
    database.close();
  });

  it("advances every multipart position when the final plaintext is malformed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const firstHeader = userHeader(harness, 133, {
      msgId: "source.multipart-malformed-final",
      clientMsgId: "client:multipart-malformed-final",
      part: 0,
      parts: 2,
    });
    const finalHeader = { ...firstHeader, part: 1 };

    await stageAndClassify(
      harness,
      firstHeader,
      frameFor(firstHeader, 133),
      new TextEncoder().encode('{"v":1,"text":"'),
      0,
      "multipart-malformed-first",
    );
    expect(database.ingress.readRouteState(harness.routeId)?.positions[0]).toMatchObject({
      cursorDisposition: "blocked",
    });

    const terminal = await stageAndClassify(
      harness,
      finalHeader,
      frameFor(finalHeader, 134),
      new TextEncoder().encode("unterminated"),
      1,
      "multipart-malformed-final",
    );
    expect(terminal.classified).toMatchObject({
      candidateState: "expired",
      resultState: "quarantined_incomplete",
    });
    expect(database.ingress.readRouteState(harness.routeId)).toMatchObject({
      positions: [
        { cursorDisposition: "advanceable", recoveryId: null, gapId: null },
        { cursorDisposition: "advanceable", recoveryId: null },
      ],
      observations: [
        { disposition: "new_part", cursorDisposition: "advanceable", gapId: null },
        { disposition: "invalid_payload", cursorDisposition: "advanceable" },
      ],
      results: [{ state: "quarantined_incomplete", acceptedDeliveryAttemptId: null }],
      candidates: [{ state: "expired", receivedParts: 2 }],
    });

    recomputeSemanticCursor(harness, "multipart-malformed-final");
    expect(database.ingress.readRouteState(harness.routeId)?.semanticCursor).toMatchObject({
      nextGeneration: 0,
      nextFrameIndex: 2,
      contiguousThroughGeneration: 0,
      contiguousThroughFrameIndex: 1,
    });
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(reopened.ingress.readRouteState(harness.routeId)).toMatchObject({
      semanticCursor: {
        nextGeneration: 0,
        nextFrameIndex: 2,
        contiguousThroughGeneration: 0,
        contiguousThroughFrameIndex: 1,
      },
      positions: [
        { cursorDisposition: "advanceable", gapId: null },
        { cursorDisposition: "advanceable" },
      ],
      results: [{ state: "quarantined_incomplete", acceptedDeliveryAttemptId: null }],
    });
    reopened.close();
  });

  it("unblocks a multipart prefix when its precompletion transport collision recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 135, {
      msgId: "source.multipart-transport-collision",
      clientMsgId: "client:multipart-transport-collision",
      part: 0,
      parts: 2,
    });
    const plaintext = new TextEncoder().encode('{"v":1,"text":"prefix');

    await stageAndClassify(
      harness,
      header,
      frameFor(header, 135),
      plaintext,
      0,
      "multipart-transport-first",
    );
    const collision = await stageAndClassify(
      harness,
      header,
      frameFor(header, 136),
      plaintext,
      1,
      "multipart-transport-collision",
    );
    expect(collision.classified).toMatchObject({
      candidateState: "collision",
      resultState: "quarantined_collision",
    });
    let durable = database.ingress.readRouteState(harness.routeId);
    const gap = durable?.gaps.find(
      (entry) => entry.reason === "transport_collision" && entry.state === "open",
    );
    expect(gap).toBeDefined();
    expect(durable?.positions).toMatchObject([
      { cursorDisposition: "blocked", gapId: null, recoveryId: null },
      { cursorDisposition: "blocked", gapId: gap?.gapId, recoveryId: null },
    ]);

    recoverGap(
      harness,
      gap?.gapId ?? parseA1SafeId("missing-multipart-transport-gap"),
      "multipart-transport",
    );
    durable = database.ingress.readRouteState(harness.routeId);
    expect(durable).toMatchObject({
      runtime: { state: "current", activeGapCount: 0 },
      positions: [
        { cursorDisposition: "advanceable", gapId: null, recoveryId: null },
        {
          cursorDisposition: "advanceable",
          recoveryId: parseA1SafeId("recovery-multipart-transport"),
        },
      ],
      observations: [
        { disposition: "new_part", cursorDisposition: "advanceable", recoveryId: null },
        {
          disposition: "collision",
          cursorDisposition: "advanceable",
          recoveryId: parseA1SafeId("recovery-multipart-transport"),
        },
      ],
      results: [{ state: "quarantined_collision", acceptedDeliveryAttemptId: null }],
    });

    recomputeSemanticCursor(harness, "multipart-transport");
    expect(database.ingress.readRouteState(harness.routeId)?.semanticCursor).toMatchObject({
      nextGeneration: 0,
      nextFrameIndex: 2,
      contiguousThroughGeneration: 0,
      contiguousThroughFrameIndex: 1,
    });
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(reopened.ingress.readRouteState(harness.routeId)).toMatchObject({
      runtime: { state: "current", activeGapCount: 0 },
      semanticCursor: {
        nextGeneration: 0,
        nextFrameIndex: 2,
        contiguousThroughGeneration: 0,
        contiguousThroughFrameIndex: 1,
      },
      positions: [
        { cursorDisposition: "advanceable", gapId: null, recoveryId: null },
        {
          cursorDisposition: "advanceable",
          recoveryId: parseA1SafeId("recovery-multipart-transport"),
        },
      ],
      results: [{ state: "quarantined_collision", acceptedDeliveryAttemptId: null }],
    });
    reopened.close();
  });

  it("latches transport and semantic collisions, preserves the accepted vector, and recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const acceptedHeader = userHeader(harness, 63, {
      msgId: "source.collision-1",
      clientMsgId: "client:accepted",
    });
    const accepted = await stageAndClassify(
      harness,
      acceptedHeader,
      frameFor(acceptedHeader, 74),
      new TextEncoder().encode('{"v":1,"text":"accepted"}'),
      0,
      "collision-accepted",
    );
    const acceptedAttemptId = acceptedHeader.deliveryAttemptId;

    const transportHeader = { ...acceptedHeader, clientMsgId: "client:changed-transport" };
    const transport = await stageAndClassify(
      harness,
      transportHeader,
      frameFor(transportHeader, 75),
      new TextEncoder().encode('{"v":1,"text":"accepted"}'),
      1,
      "transport-collision",
    );
    expect(transport.classified).toMatchObject({
      candidateState: "complete",
      stableSemanticResultId: accepted.resultId,
    });
    let durable = database.ingress.readRouteState(harness.routeId);
    const transportGap = durable?.gaps.find(
      (gap) => gap.reason === "transport_collision" && gap.state === "open",
    );
    expect(transportGap).toBeDefined();
    expect(durable?.results[0]).toMatchObject({
      acceptedDeliveryAttemptId: acceptedAttemptId,
      canonicalMessageDigest: accepted.classified.canonicalMessageDigest,
    });
    expect(durable?.positions[1]).toMatchObject({
      cursorDisposition: "blocked",
      gapId: transportGap?.gapId,
    });
    recoverGap(harness, transportGap?.gapId ?? parseA1SafeId("missing-gap"), "transport");
    durable = database.ingress.readRouteState(harness.routeId);
    expect(durable?.positions[1]).toMatchObject({
      cursorDisposition: "advanceable",
      recoveryId: parseA1SafeId("recovery-transport"),
    });

    const semanticHeader = userHeader(harness, 64, {
      msgId: acceptedHeader.msgId,
      clientMsgId: "client:changed-semantic",
    });
    const semantic = await stageAndClassify(
      harness,
      semanticHeader,
      frameFor(semanticHeader, 76),
      new TextEncoder().encode('{"v":1,"text":"different"}'),
      2,
      "semantic-collision",
    );
    expect(semantic.resultId).toBe(accepted.resultId);
    durable = database.ingress.readRouteState(harness.routeId);
    const semanticGap = durable?.gaps.find(
      (gap) => gap.reason === "semantic_collision" && gap.state === "open",
    );
    expect(semanticGap).toBeDefined();
    expect(durable?.results[0]).toMatchObject({
      state: "quarantined_collision",
      acceptedDeliveryAttemptId: acceptedAttemptId,
      canonicalMessageDigest: accepted.classified.canonicalMessageDigest,
    });
    recoverGap(harness, semanticGap?.gapId ?? parseA1SafeId("missing-gap"), "semantic");
    durable = database.ingress.readRouteState(harness.routeId);
    expect(durable?.positions[2]).toMatchObject({
      cursorDisposition: "advanceable",
      recoveryId: parseA1SafeId("recovery-semantic"),
    });
    const runtime = durable?.runtime;
    database.close();
    expect(runtime).toMatchObject({ state: "current", activeGapCount: 0 });
  });

  it("durably terminalizes malformed complete plaintext without blocking its cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 68, { msgId: "source.invalid-payload" });
    const classified = await stageAndClassify(
      harness,
      header,
      frameFor(header, 81),
      new TextEncoder().encode("not-json"),
      0,
      "invalid-payload",
    );
    expect(classified.classified).toMatchObject({
      candidateState: "expired",
      resultState: "quarantined_incomplete",
    });
    expect(database.ingress.readRouteState(harness.routeId)).toMatchObject({
      gaps: [{ reason: "invalid_frame", state: "open" }],
      positions: [
        {
          classification: "inbound_ingress",
          cursorDisposition: "advanceable",
          recoveryId: null,
        },
      ],
      observations: [
        {
          disposition: "invalid_payload",
          cursorDisposition: "advanceable",
          recoveryId: null,
        },
      ],
    });
    database.close();
  });

  it("resolves a sole gap before durably closing its source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 118, { msgId: "source.close-one-gap" });
    await stageAndClassify(
      harness,
      header,
      frameFor(header, 118),
      new TextEncoder().encode("not-json"),
      0,
      "close-one-gap",
    );
    const gap = database.ingress
      .readRouteState(harness.routeId)
      ?.gaps.find((entry) => entry.state === "open");
    recoverGap(
      harness,
      gap?.gapId ?? parseA1SafeId("missing-close-gap"),
      "close-one-gap",
      "discard_and_close_source",
    );
    expect(database.ingress.readRouteState(harness.routeId)).toMatchObject({
      runtime: { state: "closed", activeGapCount: 0 },
      gaps: [{ state: "resolved", recoveryId: parseA1SafeId("recovery-close-one-gap") }],
    });
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(reopened.ingress.readRouteState(harness.routeId)?.runtime).toMatchObject({
      state: "closed",
      activeGapCount: 0,
    });
    reopened.close();
  });

  it("rejects discard-and-close when another route gap remains open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    for (let index = 0; index < 2; index++) {
      const header = userHeader(harness, 119 + index, {
        msgId: `source.close-multiple-${index}`,
      });
      await stageAndClassify(
        harness,
        header,
        frameFor(header, 119 + index),
        new TextEncoder().encode("not-json"),
        index,
        `close-multiple-${index}`,
      );
    }
    const before = database.ingress.readRouteState(harness.routeId);
    const gap = before?.gaps.find((entry) => entry.state === "open");
    expect(before?.runtime).toMatchObject({ state: "quarantined", activeGapCount: 2 });
    expect(() =>
      recoverGap(
        harness,
        gap?.gapId ?? parseA1SafeId("missing-close-multiple-gap"),
        "close-multiple",
        "discard_and_close_source",
      ),
    ).toThrow(/sole open gap/);
    expect(database.ingress.readRouteState(harness.routeId)).toMatchObject({
      runtime: { state: "quarantined", activeGapCount: 2 },
      gaps: [
        { state: "open", recoveryId: null },
        { state: "open", recoveryId: null },
      ],
    });
    database.close();
  });

  it("classifies a fifth changed-header attempt without consuming a fifth candidate slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const plaintext = new TextEncoder().encode('{"v":1,"text":"candidate cap"}');
    let acceptedResultId: ReturnType<typeof parseA1SafeId> | undefined;
    for (let candidate = 0; candidate < 4; candidate++) {
      const header = userHeader(harness, 90 + candidate, {
        msgId: "source.candidate-cap",
        clientMsgId: "client:candidate-cap",
      });
      const classified = await stageAndClassify(
        harness,
        header,
        frameFor(header, 100 + candidate),
        plaintext,
        candidate,
        `candidate-cap-${candidate}`,
      );
      acceptedResultId ??= classified.resultId;
      expect(classified.classified).toMatchObject({
        candidateState: "complete",
        resultState: "awaiting_order",
      });
    }
    expect(database.ingress.readRouteState(harness.routeId)?.candidates).toHaveLength(4);

    const hostileHeader = userHeader(harness, 94, {
      msgId: "source.candidate-cap",
      clientMsgId: "client:changed-after-cap",
    });
    const hostile = await stageAndClassify(
      harness,
      hostileHeader,
      frameFor(hostileHeader, 104),
      new TextEncoder().encode('{"v":1,"text":"hostile"}'),
      4,
      "candidate-cap-hostile",
    );
    expect(hostile).toMatchObject({
      resultId: acceptedResultId,
      classified: { candidateState: "collision", resultState: "quarantined_collision" },
    });
    const durable = database.ingress.readRouteState(harness.routeId);
    expect(durable?.candidates).toHaveLength(4);
    expect(durable?.attempts).toHaveLength(5);
    expect(durable?.gaps).toContainEqual(
      expect.objectContaining({ reason: "semantic_collision", state: "open" }),
    );
    database.close();
  });

  it("expires an incomplete multipart result and advances a late tombstone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const firstHeader = userHeader(harness, 65, {
      msgId: "source.expiry-1",
      clientMsgId: "client:expiry-1",
      part: 0,
      parts: 2,
    });
    const first = await stageAndClassify(
      harness,
      firstHeader,
      frameFor(firstHeader, 77),
      new TextEncoder().encode('{"v":1,"text":"late'),
      0,
      "expiry-first",
    );
    const deadline = database.ingress.readRouteState(harness.routeId)?.results[0]
      ?.assemblyDeadlineMs;
    expect(deadline).toBe(NOW_MS + 300_000);
    vi.setSystemTime(deadline ?? NOW_MS + 300_000);
    recordMutation(
      harness,
      database.ingress.expireResult({
        ...coordinate(harness, "op-expire-result"),
        stableSemanticResultId: first.resultId,
        expectedAssemblyDeadlineMs: deadline ?? NOW_MS + 300_000,
      }),
    );
    expect(database.ingress.readRouteState(harness.routeId)).toMatchObject({
      results: [{ state: "quarantined_incomplete" }],
      candidates: [{ state: "expired" }],
      positions: [{ cursorDisposition: "advanceable" }],
    });

    const lateHeader = { ...firstHeader, part: 1 };
    const late = await stageAndClassify(
      harness,
      lateHeader,
      frameFor(lateHeader, 78),
      new TextEncoder().encode(' payload"}'),
      1,
      "expiry-late",
    );
    expect(late.classified).toMatchObject({
      candidateState: "expired",
      resultState: "quarantined_incomplete",
    });
    const durable = database.ingress.readRouteState(harness.routeId);
    expect(durable?.observations[1]).toMatchObject({
      disposition: "late_after_tombstone",
      cursorDisposition: "advanceable",
      gapId: null,
    });
    expect(durable?.parts).toHaveLength(1);
    database.close();
  });

  it("rejects a stale actor and lets a successor coordinator take over an unreleased claim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    vi.setSystemTime(NOW_MS + 600_001);
    const successor = database.records.acquireCoordinatorLease({
      collaborationServerId: harness.serverId,
      candidateLeaseId: canonicalId("coordinatorLease", 42),
      ownerInstanceId: parseA1SafeId("a17-ingress-successor"),
      expectedCurrentLeaseId: harness.fence.coordinatorLeaseId,
      expectedCoordinatorEpoch: harness.fence.coordinatorEpoch,
      leaseDurationMs: 600_000,
    });
    expect(() =>
      database.ingress.releaseRouteActor({
        ...coordinate(harness, "op-stale-release"),
      }),
    ).toThrow(IngressRepositoryStaleCoordinatorError);

    const successorFence = {
      collaborationServerId: harness.serverId,
      coordinatorLeaseId: successor.lease.coordinatorLeaseId,
      coordinatorEpoch: successor.lease.coordinatorEpoch,
    };
    const successorClaimToken = parseA1SafeId("actor-claim-successor");
    const claimed = database.ingress.claimRouteActor({
      scope: harness.scope,
      fence: successorFence,
      claimToken: successorClaimToken,
      expectedActorRevision: harness.actorRevision,
      operationId: parseA1SafeId("op-successor-claim"),
      observedAtMs: Date.now(),
    });
    const successorHarness: IngressHarness = {
      ...harness,
      fence: successorFence,
      claimToken: successorClaimToken,
      actorRevision: claimed.actor.revision,
    };
    const released = database.ingress.releaseRouteActor({
      ...coordinate(successorHarness, "op-successor-release"),
    });
    expect(released.actor).toMatchObject({
      revision: claimed.actor.revision + 1,
      claimToken: null,
      coordinatorLeaseId: null,
    });
    database.close();
  });

  it("enforces the 1,024-frame unresolved lookahead in real SQLite", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 66, { msgId: "source.lookahead" });
    const frame = frameFor(header, 79);
    for (let page = 0; page < 16; page++) {
      const start = page * 64;
      const prepared = await prepareStagePage(harness, new Array(64).fill(frame), start);
      database.transaction((transaction) =>
        stagePage(harness, transaction, prepared, `op-lookahead-${page}`),
      );
    }
    expect(database.ingress.readRouteState(harness.routeId)?.positions).toHaveLength(1_024);
    const overflow = await prepareStagePage(harness, [frame], 1_024);
    expect(() =>
      database.transaction((transaction) =>
        stagePage(harness, transaction, overflow, "op-lookahead-overflow"),
      ),
    ).toThrow(IngressRepositoryQuotaError);
    expect(database.ingress.readRouteState(harness.routeId)?.positions).toHaveLength(1_024);
    database.close();
  });

  it("rejects direct candidate fabrication and classified-evidence rewrites", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 69, {
      msgId: "source.direct-mutation",
      part: 0,
      parts: 2,
    });
    await stageAndClassify(
      harness,
      header,
      frameFor(header, 82),
      new TextEncoder().encode('{"v":1,"text":"half'),
      0,
      "direct-mutation",
    );
    const positionId = database.ingress.readRouteState(harness.routeId)?.positions[0]
      ?.channelPositionObservationId;
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    const expectRejected = (sql: string, parameters: readonly (string | number)[]) => {
      editor.exec("BEGIN IMMEDIATE");
      try {
        expect(() => editor.prepare(sql).run(...parameters)).toThrow();
      } finally {
        editor.exec("ROLLBACK");
      }
    };
    try {
      expectRejected(
        `UPDATE ingress_delivery_candidates
            SET received_parts=expected_parts, plaintext_byte_count=plaintext_byte_count+1,
                state='complete'
          WHERE broker_route_id=?`,
        [harness.routeId],
      );
      expectRejected(
        `UPDATE authenticated_channel_positions
            SET normalized_transport_frame_digest=?
          WHERE channel_position_observation_id=?`,
        [digestBytes(new Uint8Array([201])), positionId ?? parseA1SafeId("missing-position")],
      );
    } finally {
      editor.close();
    }
  });

  it("rejects a direct semantic-cursor jump over a blocked hole", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const blockedHeader = userHeader(harness, 70, { msgId: "source.blocked-hole" });
    const acceptedHeader = userHeader(harness, 71, { msgId: "source.after-hole" });
    const prepared = await prepareStagePage(
      harness,
      [frameFor(blockedHeader, 83), frameFor(acceptedHeader, 84)],
      0,
    );
    database.transaction((transaction) =>
      stagePage(harness, transaction, prepared, "op-stage-blocked-hole"),
    );
    const second = prepared.frames[1];
    if (second === undefined) throw new Error("second staged position is absent");
    const classification = await prepareClassification(
      harness,
      acceptedHeader,
      second.positionId,
      second.transportDigest,
      new TextEncoder().encode('{"v":1,"text":"after hole"}'),
    );
    database.transaction((transaction) =>
      classifyPart(harness, transaction, classification, "op-classify-after-hole"),
    );
    expect(database.ingress.readRouteState(harness.routeId)?.positions).toMatchObject([
      { cursorDisposition: "blocked" },
      { cursorDisposition: "advanceable" },
    ]);
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    editor.exec("BEGIN IMMEDIATE");
    try {
      expect(() =>
        editor
          .prepare(
            `UPDATE broker_route_semantic_cursors
                SET next_generation=0, next_frame_index=2,
                    contiguous_through_generation=0, contiguous_through_frame_index=1,
                    revision=revision+1, updated_at_ms=?
              WHERE broker_route_id=?`,
          )
          .run(NOW_MS, harness.routeId),
      ).toThrow();
    } finally {
      editor.exec("ROLLBACK");
      editor.close();
    }
  });

  it("fails secure reopen when accepted semantic evidence is corrupted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 67, { msgId: "source.corruption" });
    const completed = await stageAndClassify(
      harness,
      header,
      frameFor(header, 80),
      new TextEncoder().encode('{"v":1,"text":"before corruption"}'),
      0,
      "corruption",
    );
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      const trigger = editor
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type='trigger'
              AND name='authenticated_ingress_results_require_legal_update'`,
        )
        .get() as { sql: string };
      editor.exec("DROP TRIGGER authenticated_ingress_results_require_legal_update");
      editor
        .prepare(
          `UPDATE authenticated_ingress_results
              SET canonical_message_digest=? WHERE stable_semantic_result_id=?`,
        )
        .run(digestBytes(new Uint8Array([255])), completed.resultId);
      editor.exec(trigger.sql);
    } finally {
      editor.close();
    }
    let unexpected: HostStateDatabase | undefined;
    try {
      expect(() => {
        unexpected = openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        });
      }).toThrow(/durable ingress records failed semantic validation/);
    } finally {
      unexpected?.close();
    }
  });

  it("fails secure reopen when retained page-frame claims no longer close over the position", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 121, { msgId: "source.corrupt-page-claim" });
    await stageAndClassify(
      harness,
      header,
      frameFor(header, 121),
      new TextEncoder().encode('{"v":1,"text":"page claim"}'),
      0,
      "corrupt-page-claim",
    );
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      const noUpdate = editor
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type='trigger'
            AND name='broker_read_page_frame_evidence_no_update'`,
        )
        .get() as { sql: string };
      const scopeUpdate = editor
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type='trigger'
            AND name='broker_read_page_frame_evidence_require_exact_route_scope_update'`,
        )
        .get() as { sql: string };
      editor.exec("DROP TRIGGER broker_read_page_frame_evidence_no_update");
      editor.exec("DROP TRIGGER broker_read_page_frame_evidence_require_exact_route_scope_update");
      editor
        .prepare(
          `UPDATE broker_read_page_frame_evidence SET claimed_part=1
            WHERE broker_route_id=? AND ordinal=0`,
        )
        .run(harness.routeId);
      editor.exec(noUpdate.sql);
      editor.exec(scopeUpdate.sql);
    } finally {
      editor.close();
    }
    let unexpected: HostStateDatabase | undefined;
    try {
      expect(() => {
        unexpected = openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        });
      }).toThrow(/durable ingress records failed semantic validation/);
    } finally {
      unexpected?.close();
    }
  });

  it("fails secure reopen when a recovery no longer matches its lease lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 122, { msgId: "source.corrupt-recovery" });
    await stageAndClassify(
      harness,
      header,
      frameFor(header, 122),
      new TextEncoder().encode("not-json"),
      0,
      "corrupt-recovery",
    );
    const gap = database.ingress
      .readRouteState(harness.routeId)
      ?.gaps.find((entry) => entry.state === "open");
    recoverGap(
      harness,
      gap?.gapId ?? parseA1SafeId("missing-corrupt-recovery-gap"),
      "corrupt-recovery",
    );
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      const noUpdate = editor
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type='trigger'
            AND name='channel_position_recoveries_no_update'`,
        )
        .get() as { sql: string };
      const scopeUpdate = editor
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type='trigger'
            AND name='channel_position_recoveries_require_exact_route_scope_update'`,
        )
        .get() as { sql: string };
      editor.exec("DROP TRIGGER channel_position_recoveries_no_update");
      editor.exec("DROP TRIGGER channel_position_recoveries_require_exact_route_scope_update");
      editor
        .prepare(
          `UPDATE channel_position_recoveries SET decided_at_ms=decided_at_ms+700000
            WHERE broker_route_id=?`,
        )
        .run(harness.routeId);
      editor.exec(noUpdate.sql);
      editor.exec(scopeUpdate.sql);
    } finally {
      editor.close();
    }
    let unexpected: HostStateDatabase | undefined;
    try {
      expect(() => {
        unexpected = openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        });
      }).toThrow(/durable ingress records failed semantic validation/);
    } finally {
      unexpected?.close();
    }
  });

  it("rejects an omitted zero-frame page before retaining durable evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const prepared = await prepareStagePage(harness, [], 0);
    const omittedPageBytes = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        broker_route_id: harness.routeId,
        route_store_instance_id: ROUTE_STORE_INSTANCE_ID,
        requested_position: prepared.requestedPosition,
        generation: prepared.generation,
        observed_next_frame_index: 1,
        frames: [],
        next_position: prepared.nextPosition,
        at_live_tail: false,
      }),
    );
    const omitted = {
      ...prepared,
      generation: prepared.generation,
      nextPosition: prepared.nextPosition,
      pageBytes: omittedPageBytes,
      pageDigest: digestBytes(omittedPageBytes),
    };
    expect(() =>
      database.transaction((transaction) => {
        const page = transaction.putArtifact({
          scopeKind: "collaboration_server",
          scopeId: harness.serverId,
          artifactSchemaId: A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
          artifactDigest: omitted.pageDigest,
          artifactBytes: ProtectedByteSnapshot.from(omitted.pageBytes),
        });
        return transaction.ingress.stageReadPage({
          ...coordinate(harness, "op-omitted-empty-page"),
          requestedPosition: omitted.requestedPosition,
          nextPosition: omitted.nextPosition,
          generation: omitted.generation,
          observedNextFrameIndex: 1,
          frames: [],
          atLiveTail: false,
          pageEvidenceRef: page.artifactRef.protectedHandleId,
          pageEvidenceDigest: omitted.pageDigest,
        });
      }),
    ).toThrow();
    expect(database.ingress.readRouteState(harness.routeId)).toMatchObject({
      positions: [],
      readPageObservations: [],
      fetchCursor: { nextGeneration: 0, nextFrameIndex: 0 },
    });
    database.close();
  });

  it("preserves an accepted result when a fresh replay exceeds the cumulative semantic bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const partByteLength = 3_150_000;
    const expectedParts = 8;
    const plaintext = new Uint8Array(partByteLength * expectedParts);
    const prefix = new TextEncoder().encode('{"v":1,"text":"');
    const suffix = new TextEncoder().encode('"}');
    plaintext.set(prefix);
    plaintext.fill(97, prefix.byteLength, plaintext.byteLength - suffix.byteLength);
    plaintext.set(suffix, plaintext.byteLength - suffix.byteLength);
    const plaintextParts = Array.from({ length: expectedParts }, (_, part) =>
      plaintext.subarray(part * partByteLength, (part + 1) * partByteLength),
    );

    let accepted: Awaited<ReturnType<typeof stageAndClassify>> | undefined;
    for (let part = 0; part < expectedParts; part++) {
      const header = userHeader(harness, 123, {
        msgId: "source.replay-byte-cap",
        part,
        parts: expectedParts,
      });
      accepted = await stageAndClassify(
        harness,
        header,
        frameFor(header, 130 + part),
        plaintextParts[part] ?? new Uint8Array(),
        part,
        `replay-byte-cap-accepted-${part}`,
      );
    }
    if (accepted === undefined) throw new Error("missing accepted replay-bound result");
    const acceptedResult = database.ingress
      .readRouteState(harness.routeId)
      ?.results.find((result) => result.stableSemanticResultId === accepted.resultId);

    let replayAttemptId: string | undefined;
    for (let part = 0; part < expectedParts - 1; part++) {
      const header = userHeader(harness, 124, {
        msgId: "source.replay-byte-cap",
        part,
        parts: expectedParts,
      });
      replayAttemptId = header.deliveryAttemptId;
      const replayPart = await stageAndClassify(
        harness,
        header,
        frameFor(header, 140 + part),
        plaintextParts[part] ?? new Uint8Array(),
        expectedParts + part,
        `replay-byte-cap-fresh-${part}`,
      );
      expect(replayPart.classified).toMatchObject({ candidateState: "assembling" });
    }
    const replayFinalHeader = userHeader(harness, 124, {
      msgId: "source.replay-byte-cap",
      part: expectedParts - 1,
      parts: expectedParts,
    });
    replayAttemptId = replayFinalHeader.deliveryAttemptId;
    const replayFinalFrame = frameFor(replayFinalHeader, 140 + expectedParts - 1);
    const replayOverflow = await stageAndClassify(
      harness,
      replayFinalHeader,
      replayFinalFrame,
      plaintextParts.at(-1) ?? new Uint8Array(),
      expectedParts * 2 - 1,
      "replay-byte-cap-overflow",
    );
    expect(replayOverflow.classified).toMatchObject({
      candidateState: "expired",
      resultState: "awaiting_order",
      canonicalMessageDigest: acceptedResult?.canonicalMessageDigest,
      sourceEventFingerprint: acceptedResult?.sourceEventFingerprint,
    });

    const replayLate = await stageAndClassify(
      harness,
      replayFinalHeader,
      replayFinalFrame,
      plaintextParts.at(-1) ?? new Uint8Array(),
      expectedParts * 2,
      "replay-byte-cap-late",
    );
    expect(replayLate.classified).toMatchObject({
      candidateState: "expired",
      resultState: "awaiting_order",
    });
    const durable = database.ingress.readRouteState(harness.routeId);
    expect(
      durable?.results.find((result) => result.stableSemanticResultId === accepted.resultId),
    ).toMatchObject({
      state: "awaiting_order",
      acceptedDeliveryAttemptId: attemptId(123),
      canonicalMessageDigest: acceptedResult?.canonicalMessageDigest,
      sourceEventFingerprint: acceptedResult?.sourceEventFingerprint,
    });
    expect(
      durable?.candidates.find((candidate) => candidate.deliveryAttemptId === replayAttemptId),
    ).toMatchObject({
      state: "expired",
      receivedParts: expectedParts - 1,
      plaintextByteCount: partByteLength * (expectedParts - 1),
    });
    expect(durable?.observations.slice(-2)).toMatchObject([
      { disposition: "invalid_payload", cursorDisposition: "advanceable" },
      { disposition: "invalid_payload", cursorDisposition: "advanceable" },
    ]);
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(
      reopened.ingress
        .readRouteState(harness.routeId)
        ?.results.find((result) => result.stableSemanticResultId === accepted.resultId),
    ).toMatchObject({
      state: "awaiting_order",
      acceptedDeliveryAttemptId: attemptId(123),
      canonicalMessageDigest: acceptedResult?.canonicalMessageDigest,
      sourceEventFingerprint: acceptedResult?.sourceEventFingerprint,
    });
    reopened.close();
    plaintext.fill(0);
  }, 30_000);

  it("retains a recovered route transplant as pre-attempt transport-key evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const localHeader = userHeader(harness, 126, { msgId: "source.pre-attempt-transport-key" });
    const transplantedHeader = {
      ...localHeader,
      logicalChatId: canonicalId("logicalChat", 126),
    };
    const firstStage = await prepareStageFrame(harness, frameFor(transplantedHeader, 128), 0);
    const first = database.transaction((transaction) =>
      stageFrame(harness, transaction, firstStage, "op-stage-pre-attempt-invalid"),
    );
    const gapBytes = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        broker_route_id: harness.routeId,
        failure_code: "route_mismatch",
        channel_position_observation_id: first.positionId,
        requested_position: null,
      }),
    );
    const gapDigest = digestBytes(gapBytes);
    database.transaction((transaction) => {
      const gapEvidence = transaction.putArtifact({
        scopeKind: "collaboration_server",
        scopeId: harness.serverId,
        artifactSchemaId: A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
        artifactDigest: gapDigest,
        artifactBytes: ProtectedByteSnapshot.from(gapBytes),
      });
      recordMutation(
        harness,
        transaction.ingress.classifyInvalidPosition({
          ...coordinate(harness, "op-classify-pre-attempt-invalid"),
          channelPositionObservationId: first.positionId,
          parsed: {
            channelPositionObservationId: first.positionId,
            normalizedTransportFrameDigest: first.transportDigest,
            header: transplantedHeader,
          },
          validationFailureCode: parseA1SafeId("route_mismatch"),
          gapEvidenceRef: gapEvidence.artifactRef.protectedHandleId,
          gapEvidenceDigest: gapDigest,
        }),
      );
    });
    const invalidGap = database.ingress
      .readRouteState(harness.routeId)
      ?.gaps.find((gap) => gap.reason === "invalid_frame" && gap.state === "open");
    recoverGap(
      harness,
      invalidGap?.gapId ?? parseA1SafeId("missing-route-mismatch-gap"),
      "route-mismatch",
    );

    const conflicting = await stageAndClassify(
      harness,
      localHeader,
      frameFor(localHeader, 129),
      new TextEncoder().encode('{"v":1,"text":"authenticated later"}'),
      1,
      "pre-attempt-transport-conflict",
    );
    expect(conflicting.classified).toMatchObject({
      candidateState: "collision",
      resultState: "quarantined_collision",
    });
    const durable = database.ingress.readRouteState(harness.routeId);
    expect(durable?.attempts).toHaveLength(0);
    expect(durable?.candidates).toHaveLength(0);
    expect(durable?.gaps.find((gap) => gap.reason === "transport_collision")).toMatchObject({
      state: "open",
    });
    expect(durable?.gaps.find((gap) => gap.reason === "invalid_frame")).toMatchObject({
      state: "resolved",
    });
    expect(durable?.observations).toMatchObject([
      { disposition: "collision", cursorDisposition: "blocked" },
    ]);
    database.close();

    const inspection = new DatabaseSync(state.paths.databasePath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare(
            `SELECT original_channel_generation, original_frame_index,
                    original_transport_frame_digest
               FROM broker_transport_key_collisions WHERE broker_route_id=?`,
          )
          .get(harness.routeId),
      ).toEqual({
        original_channel_generation: 0,
        original_frame_index: 0,
        original_transport_frame_digest: first.transportDigest,
      });
    } finally {
      inspection.close();
    }
  });

  it("rejects reusing one same-server ingress artifact across broker routes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const first = installHarness(database);
    const second = installAdditionalHarness(database, first);
    expect(second.serverId).toBe(first.serverId);

    const firstHeader = userHeader(first, 127, { msgId: "source.cross-route-artifact" });
    const frame = frameFor(firstHeader, 130);
    const preparedFirst = await prepareStageFrame(first, frame, 0);
    const stagedFirst = database.transaction((transaction) =>
      stageFrame(first, transaction, preparedFirst, "op-stage-cross-route-first"),
    );
    const preparedSecond = await prepareStageFrame(second, frame, 0);
    expect(() =>
      database.transaction((transaction) =>
        stageFrame(
          second,
          transaction,
          preparedSecond,
          "op-stage-cross-route-second",
          stagedFirst.rawRef,
        ),
      ),
    ).toThrowError(
      new HostStateContractError("ingress artifacts cannot be shared across broker routes"),
    );
    expect(database.ingress.readRouteState(second.routeId)).toMatchObject({
      positions: [],
      readPageObservations: [],
      fetchCursor: { nextGeneration: 0, nextFrameIndex: 0 },
    });
    database.close();
  });

  it("re-quarantines an exact recurring open-tail regression and survives reopen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const firstHeader = userHeader(harness, 131, { msgId: "source.manifest-recurrence-a" });
    const secondHeader = userHeader(harness, 132, { msgId: "source.manifest-recurrence-b" });
    const firstPage = await prepareStagePage(harness, [frameFor(firstHeader, 131)], 0, 2);
    database.transaction((transaction) =>
      stagePage(harness, transaction, firstPage, "op-manifest-high-water-a"),
    );
    const secondPage = await prepareStagePage(harness, [frameFor(secondHeader, 132)], 1, 3);
    database.transaction((transaction) =>
      stagePage(harness, transaction, secondPage, "op-manifest-high-water-b"),
    );

    const regressedPage = await prepareStagePage(harness, [], 2, 2);
    database.transaction((transaction) =>
      stagePage(harness, transaction, regressedPage, "op-manifest-regression-first"),
    );
    let durable = database.ingress.readRouteState(harness.routeId);
    const firstGap = durable?.gaps.find(
      (gap) => gap.reason === "manifest_equivocation" && gap.state === "open",
    );
    expect(firstGap).toBeDefined();
    recoverGap(
      harness,
      firstGap?.gapId ?? parseA1SafeId("missing-first-manifest-recurrence-gap"),
      "manifest-recurrence-first",
    );

    database.transaction((transaction) =>
      stagePage(harness, transaction, regressedPage, "op-manifest-regression-second"),
    );
    durable = database.ingress.readRouteState(harness.routeId);
    const manifestGaps = durable?.gaps.filter((gap) => gap.reason === "manifest_equivocation");
    expect(manifestGaps).toHaveLength(2);
    expect(manifestGaps).toContainEqual(
      expect.objectContaining({ gapId: firstGap?.gapId, state: "resolved" }),
    );
    expect(manifestGaps).toContainEqual(
      expect.objectContaining({ state: "open", recoveryId: null }),
    );
    expect(durable?.runtime).toMatchObject({ state: "quarantined", activeGapCount: 1 });
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    expect(reopened.ingress.readRouteState(harness.routeId)?.runtime).toMatchObject({
      state: "quarantined",
      activeGapCount: 1,
    });
    reopened.close();
  });

  it("rejects a fabricated generation high-water with no accepted read-page evidence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      const trigger = editor
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type='trigger'
            AND name='broker_channel_generation_observations_require_legal_update'`,
        )
        .get() as { sql: string };
      editor.exec("DROP TRIGGER broker_channel_generation_observations_require_legal_update");
      editor
        .prepare(
          `UPDATE broker_channel_generation_observations
              SET observed_next_frame_index=4096, last_observed_at_ms=last_observed_at_ms+1
            WHERE broker_route_id=? AND channel_generation=0`,
        )
        .run(harness.routeId);
      editor.exec(trigger.sql);
    } finally {
      editor.close();
    }
    let unexpected: HostStateDatabase | undefined;
    try {
      expect(() => {
        unexpected = openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        });
      }).toThrow(/durable ingress records failed semantic validation/);
    } finally {
      unexpected?.close();
    }
  });

  it("rejects a fabricated future runtime clock before it can wedge authority", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      const trigger = editor
        .prepare(
          `SELECT sql FROM sqlite_schema WHERE type='trigger'
            AND name='broker_route_runtime_status_require_legal_update'`,
        )
        .get() as { sql: string };
      editor.exec("DROP TRIGGER broker_route_runtime_status_require_legal_update");
      editor
        .prepare(`UPDATE broker_route_runtime_status SET updated_at_ms=? WHERE broker_route_id=?`)
        .run(Number.MAX_SAFE_INTEGER, harness.routeId);
      editor.exec(trigger.sql);
    } finally {
      editor.close();
    }
    let unexpected: HostStateDatabase | undefined;
    try {
      expect(() => {
        unexpected = openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        });
      }).toThrow(/durable ingress records failed semantic validation/);
    } finally {
      unexpected?.close();
    }
  });
});

function mutateIngressHeadWithoutTrigger(
  databasePath: string,
  triggerName: string,
  mutation: (editor: DatabaseSync) => void,
): void {
  const editor = new DatabaseSync(databasePath);
  let triggerSql: string | undefined;
  let triggerDropped = false;
  try {
    const trigger = editor
      .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
      .get(triggerName) as { sql: string } | undefined;
    if (trigger === undefined) throw new Error(`missing ingress trigger ${triggerName}`);
    triggerSql = trigger.sql;
    editor.exec(`DROP TRIGGER ${triggerName}`);
    triggerDropped = true;
    mutation(editor);
    editor.exec(triggerSql);
    triggerDropped = false;
  } finally {
    if (triggerDropped && triggerSql !== undefined) editor.exec(triggerSql);
    editor.close();
  }
}

function expectIngressSecureReopenRejected(state: ReturnType<typeof temporaryState>): void {
  let unexpected: HostStateDatabase | undefined;
  try {
    expect(() => {
      unexpected = openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      });
    }).toThrow(/durable ingress records failed semantic validation/);
  } finally {
    unexpected?.close();
  }
}

describeLinux("A1.7a durable-ingress head and tombstone corruption rejection", () => {
  it.each([
    {
      label: "fetch-cursor revision exhaustion",
      table: "broker_route_fetch_cursors",
      trigger: "broker_route_fetch_cursors_require_legal_update",
      assignment: "revision=?",
      value: Number.MAX_SAFE_INTEGER - 1,
    },
    {
      label: "fetch-cursor timestamp exhaustion",
      table: "broker_route_fetch_cursors",
      trigger: "broker_route_fetch_cursors_require_legal_update",
      assignment: "updated_at_ms=?",
      value: Number.MAX_SAFE_INTEGER,
    },
    {
      label: "semantic-cursor revision exhaustion",
      table: "broker_route_semantic_cursors",
      trigger: "broker_route_semantic_cursors_require_legal_update",
      assignment: "revision=?",
      value: Number.MAX_SAFE_INTEGER - 1,
    },
    {
      label: "semantic-cursor timestamp exhaustion",
      table: "broker_route_semantic_cursors",
      trigger: "broker_route_semantic_cursors_require_legal_update",
      assignment: "updated_at_ms=?",
      value: Number.MAX_SAFE_INTEGER,
    },
  ])("rejects trigger-restored $label on secure reopen", ({
    table,
    trigger,
    assignment,
    value,
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    database.close();

    mutateIngressHeadWithoutTrigger(state.paths.databasePath, trigger, (editor) => {
      editor
        .prepare(`UPDATE ${table} SET ${assignment} WHERE broker_route_id=?`)
        .run(value, harness.routeId);
    });

    expectIngressSecureReopenRejected(state);
  });

  it.each([
    {
      label: "actor revision exhaustion",
      assignment: "revision=?",
      value: Number.MAX_SAFE_INTEGER - 1,
    },
    {
      label: "actor timestamp exhaustion",
      assignment: "updated_at_ms=?",
      value: Number.MAX_SAFE_INTEGER,
    },
  ])("rejects trigger-restored $label on secure reopen", ({ assignment, value }) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    database.close();

    mutateIngressHeadWithoutTrigger(
      state.paths.databasePath,
      "broker_route_actors_require_legal_update",
      (editor) => {
        editor
          .prepare(`UPDATE broker_route_actors SET ${assignment} WHERE broker_route_id=?`)
          .run(value, harness.routeId);
      },
    );

    expectIngressSecureReopenRejected(state);
  });

  it("rejects a fabricated awaiting-order collision tombstone without causal evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const header = userHeader(harness, 170, { msgId: "source.fabricated-collision" });
    const completed = await stageAndClassify(
      harness,
      header,
      frameFor(header, 180),
      new TextEncoder().encode('{"v":1,"text":"accepted"}'),
      0,
      "fabricated-collision",
    );
    expect(database.ingress.readRouteState(harness.routeId)?.results[0]?.state).toBe(
      "awaiting_order",
    );
    database.close();

    mutateIngressHeadWithoutTrigger(
      state.paths.databasePath,
      "authenticated_ingress_results_require_legal_update",
      (editor) => {
        editor
          .prepare(
            `UPDATE authenticated_ingress_results
                SET state='quarantined_collision', collision_at_ms=?, terminal_at_ms=?
              WHERE stable_semantic_result_id=?`,
          )
          .run(NOW_MS, NOW_MS, completed.resultId);
      },
    );

    expectIngressSecureReopenRejected(state);
  });

  it("freezes collision and terminal timestamps after a causal collision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const harness = installHarness(database);
    const acceptedHeader = userHeader(harness, 171, {
      msgId: "source.frozen-collision-clock",
      clientMsgId: "client:frozen-collision-clock",
    });
    const accepted = await stageAndClassify(
      harness,
      acceptedHeader,
      frameFor(acceptedHeader, 181),
      new TextEncoder().encode('{"v":1,"text":"accepted"}'),
      0,
      "frozen-collision-accepted",
    );
    const conflictingHeader = userHeader(harness, 172, {
      msgId: acceptedHeader.msgId,
      clientMsgId: acceptedHeader.clientMsgId,
    });
    const conflicting = await stageAndClassify(
      harness,
      conflictingHeader,
      frameFor(conflictingHeader, 182),
      new TextEncoder().encode('{"v":1,"text":"conflicting"}'),
      1,
      "frozen-collision-conflicting",
    );
    expect(conflicting).toMatchObject({
      resultId: accepted.resultId,
      classified: { resultState: "quarantined_collision" },
    });
    database.close();

    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      expect(() =>
        editor
          .prepare(
            `UPDATE authenticated_ingress_results
                SET collision_at_ms=collision_at_ms+1, terminal_at_ms=terminal_at_ms+1
              WHERE stable_semantic_result_id=?`,
          )
          .run(accepted.resultId),
      ).toThrow(/authenticated ingress result transition is not allowed/);
    } finally {
      editor.close();
    }
  });
});
