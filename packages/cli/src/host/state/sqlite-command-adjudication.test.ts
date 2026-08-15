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
import { signRejectedCommandResultPreparation } from "../server-signer/command-result-orchestrator.js";
import {
  acquireUsableServerSigningLease,
  resumeInitialServerSigner,
} from "../server-signer/orchestrator.js";
import { createServerKeyCustodySigner } from "../server-signer/service.js";
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
import type {
  FinalizeSignedRejectedCommandResultRequest,
  MaterializeReadyA1IngressCommandRequest,
  ReserveRejectedCommandDecisionRequest,
} from "./command-adjudication-repository.js";
import {
  type A1CanonicalId,
  type A1CanonicalIdKind,
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
} from "./ingress-repository.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  openHostStateDatabase,
  type TerminalRegistrationInput,
} from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "d7".repeat(16);
const IDENTITY_BYTES = Uint8Array.from(Buffer.from(MACHINE_IDENTITY_ID, "hex"));
const NOW_MS = 1_700_000;
const LEASE_DURATION_MS = 600_000;
const ROUTE_STORE_INSTANCE_ID = parseBrokerRouteStoreInstanceId(
  `rbsi_${base64urlEncode(new Uint8Array(16).fill(81))}`,
);
const describeLinux = describe.runIf(
  process.platform === "linux" &&
    typeof process.getuid === "function" &&
    HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
);
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
    descriptorRef: parseA1SafeId(`command-descriptor-${fill}`),
    descriptorDigest: digestBytes(new Uint8Array([fill, 1])),
    projectRef: parseA1SafeId(`command-project-${fill}`),
    projectDigest: digestBytes(new Uint8Array([fill, 2])),
    expectedNativeRefDigest: null,
    initialPhase: "starting",
    metadataSchemaId: "remote-claw/sqlite-command-adjudication-test/v1",
    metadataRef: parseA1SafeId(`command-metadata-${fill}`),
    metadataDigest: digestBytes(new Uint8Array([fill, 3])),
    capabilitiesRef: null,
    capabilitiesDigest: null,
  };
}

function temporaryState() {
  const root = mkdtempSync(join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a17b1-command-"));
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
        routeStoreInstanceId: ROUTE_STORE_INSTANCE_ID,
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

function serverControlRouteRequest(
  serverId: A1CanonicalId<"collaborationServer">,
  coordinatorLeaseId: A1CanonicalId<"coordinatorLease">,
  artifactRef: A1CanonicalId<"protectedHandle">,
): InstallBrokerRouteRequest {
  const brokerRouteId = deriveBrokerRouteId(MACHINE_IDENTITY_ID, serverId, "server_control", null);
  const routeToken = deriveBrokerRouteToken(MACHINE_IDENTITY_ID, serverId, "server_control", null);
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
    routeKind: "server_control",
    logicalChatId: null,
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
        routeStoreInstanceId: ROUTE_STORE_INSTANCE_ID,
        identityId: MACHINE_IDENTITY_ID,
        collaborationServerId: serverId,
        routeKind: "server_control",
        logicalChatId: null,
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
  readonly chatId: A1CanonicalId<"logicalChat"> | null;
  claimToken: ReturnType<typeof parseA1SafeId>;
  actorRevision: number;
}

function installIngressHarness(
  database: HostStateDatabase,
  serverId: A1CanonicalId<"collaborationServer">,
  fence: IngressHarness["fence"],
): IngressHarness {
  const chat = database.records.reserveFirstTerminalChat({
    fence,
    workspaceSelectorId: parseA1SafeId("a17b1-command-workspace"),
    terminalTarget: {
      kind: "terminal_native",
      descriptor: { product: "codex", access: "app-server" },
      terminalProjectRef: parseA1SafeId("a17b1-command-terminal-project"),
      nativeWorkspaceBindingId: null,
    },
    mappingEvidenceRef: parseA1SafeId("a17b1-command-mapping-evidence"),
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
    return transaction.brokerRoute.install(
      routeRequest(
        serverId,
        chat.logicalChatId,
        fence.coordinatorLeaseId,
        artifact.artifactRef.protectedHandleId,
      ),
    );
  });
  const scope = {
    brokerRouteId: installation.route.brokerRouteId,
    collaborationServerId: serverId,
    routeKind: "chat" as const,
    logicalChatId: chat.logicalChatId,
  };
  const claimToken = parseA1SafeId("a17b1-command-actor-claim");
  const claim = database.ingress.claimRouteActor({
    scope,
    fence,
    claimToken,
    expectedActorRevision: 0,
    operationId: parseA1SafeId("a17b1-command-claim-operation"),
    observedAtMs: NOW_MS,
  });
  return {
    database,
    scope,
    fence,
    serverId,
    routeId: installation.route.brokerRouteId,
    chatId: chat.logicalChatId,
    claimToken,
    actorRevision: claim.actor.revision,
  };
}

function installServerControlIngressHarness(
  database: HostStateDatabase,
  serverId: A1CanonicalId<"collaborationServer">,
  fence: IngressHarness["fence"],
): IngressHarness {
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
    return transaction.brokerRoute.install(
      serverControlRouteRequest(
        serverId,
        fence.coordinatorLeaseId,
        artifact.artifactRef.protectedHandleId,
      ),
    );
  });
  const scope = {
    brokerRouteId: installation.route.brokerRouteId,
    collaborationServerId: serverId,
    routeKind: "server_control" as const,
    logicalChatId: null,
  };
  const claimToken = parseA1SafeId("a17b1-command-control-actor-claim");
  const claim = database.ingress.claimRouteActor({
    scope,
    fence,
    claimToken,
    expectedActorRevision: 0,
    operationId: parseA1SafeId("a17b1-command-control-claim-operation"),
    observedAtMs: NOW_MS,
  });
  return {
    database,
    scope,
    fence,
    serverId,
    routeId: installation.route.brokerRouteId,
    chatId: null,
    claimToken,
    actorRevision: claim.actor.revision,
  };
}

function coordinate(harness: IngressHarness, operationId: string) {
  return {
    scope: harness.scope,
    fence: harness.fence,
    actorClaimToken: harness.claimToken,
    expectedActorRevision: harness.actorRevision,
    operationId: parseA1SafeId(operationId),
    observedAtMs: Date.now(),
  };
}

function recordMutation(harness: IngressHarness, mutation: IngressMutationResult) {
  harness.actorRevision = mutation.actor.revision;
  return mutation;
}

function inboundHeader(harness: IngressHarness, frameIndex: number, tag: string): A1FrameHeaderV2 {
  const serverControl = harness.scope.routeKind === "server_control";
  return {
    v: 2,
    identityId: IDENTITY_BYTES,
    collaborationServerId: harness.serverId,
    logicalChatId: harness.chatId,
    dir: "in",
    recordKind: serverControl ? "new_chat" : "user",
    seq: null,
    msgId: `source.command-${tag}`,
    deliveryAttemptId: parseA1SafeId(
      `rda_${base64urlEncode(new Uint8Array(16).fill(90 + frameIndex))}`,
    ),
    clientMsgId: `client:command-${tag}`,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    serverKeyGeneration: null,
    hostSignerIdentityKeyId: null,
    hostScopeCertificateId: null,
    hostSignatureSequence: null,
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

async function acceptIngressSource(harness: IngressHarness, frameIndex: number, tag: string) {
  const header = inboundHeader(harness, frameIndex, tag);
  const frame = frameFor(header, 100 + frameIndex);
  const cursor = { version: 1 as const, channelGeneration: 0, frameIndex };
  const rawBytes = encodeA1EncryptedFrameV2Bytes(frame);
  const rawDigest = digestBytes(rawBytes);
  const transportDigest = digestBytes(normalizedA1TransportFrameBytes(frame));
  const positionId = parseA1SafeId(
    await deriveA1ChannelPositionObservationId(harness.routeId, cursor),
  );
  const generation = {
    schemaVersion: 1 as const,
    brokerRouteId: harness.routeId,
    channelGeneration: 0 as const,
    state: "open" as const,
    frameCount: null,
    nextGeneration: null,
    manifestDigest: null,
  };
  const requestedPosition = {
    version: 1 as const,
    channelGeneration: 0 as const,
    nextFrameIndex: frameIndex,
  };
  const nextPosition = {
    version: 1 as const,
    channelGeneration: 0 as const,
    nextFrameIndex: frameIndex + 1,
  };
  const pageBytes = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      broker_route_id: harness.routeId,
      route_store_instance_id: ROUTE_STORE_INSTANCE_ID,
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
    }),
  );
  const pageDigest = digestBytes(pageBytes);
  const staged = harness.database.transaction((transaction) => {
    const raw = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: harness.serverId,
      artifactSchemaId: A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
      artifactDigest: rawDigest,
      artifactBytes: ProtectedByteSnapshot.from(rawBytes),
    });
    const page = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: harness.serverId,
      artifactSchemaId: A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
      artifactDigest: pageDigest,
      artifactBytes: ProtectedByteSnapshot.from(pageBytes),
    });
    return recordMutation(
      harness,
      transaction.ingress.stageReadPage({
        ...coordinate(harness, `a17b1-stage-${tag}`),
        requestedPosition,
        generation,
        observedNextFrameIndex: frameIndex + 1,
        frames: [
          {
            cursor,
            channelPositionObservationId: positionId,
            claimedDeliveryAttemptId: parseA1SafeId(frame.deliveryAttemptId),
            claimedPart: 0,
            claimedTransportFrameDigest: transportDigest,
            receivedFrameRef: raw.artifactRef.protectedHandleId,
            receivedFrameDigest: rawDigest,
            receivedFrameByteLength: rawBytes.byteLength,
          },
        ],
        nextPosition,
        atLiveTail: true,
        pageEvidenceRef: page.artifactRef.protectedHandleId,
        pageEvidenceDigest: pageDigest,
      }),
    );
  });
  expect(staged.actor.revision).toBeGreaterThan(0);

  const route =
    harness.scope.routeKind === "chat"
      ? {
          routeKind: "chat" as const,
          identityId: IDENTITY_BYTES,
          collaborationServerId: harness.serverId,
          logicalChatId: harness.chatId as A1CanonicalId<"logicalChat">,
        }
      : {
          routeKind: "server_control" as const,
          identityId: IDENTITY_BYTES,
          collaborationServerId: harness.serverId,
          logicalChatId: null,
        };
  const namespaceId = parseA1SafeId(await deriveA1WebSourceNamespaceId(route));
  const resultId = parseA1SafeId(
    await deriveA1StableSemanticResultId(route, namespaceId, header.msgId),
  );
  const observationId = parseA1SafeId(await deriveA1IngressObservationId(positionId));
  const plaintext = new TextEncoder().encode(
    JSON.stringify(
      harness.scope.routeKind === "server_control"
        ? {
            v: 1,
            intent: "new_chat",
            project_id: `project-${tag}`,
            workspace_selector_id: `workspace-${tag}`,
          }
        : { v: 1, text: `hello-${tag}` },
    ),
  );
  const plaintextDigest = digestBytes(plaintext);
  const authenticatedPartDigest = parseA1Digest(await a1AuthenticatedPartDigest(header, plaintext));
  const completed = harness.database.transaction((transaction) => {
    const evidence = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: harness.serverId,
      artifactSchemaId: A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID,
      artifactDigest: plaintextDigest,
      artifactBytes: ProtectedByteSnapshot.from(plaintext),
    });
    return recordMutation(
      harness,
      transaction.ingress.classifyInboundPart({
        ...coordinate(harness, `a17b1-classify-${tag}`),
        parsed: {
          channelPositionObservationId: positionId,
          normalizedTransportFrameDigest: transportDigest,
          header,
        },
        sourceEventNamespaceId: namespaceId,
        stableSemanticResultId: resultId,
        ingressObservationId: observationId,
        plaintextPartRef: evidence.artifactRef.protectedHandleId,
        plaintextPartDigest: plaintextDigest,
        plaintextPartByteLength: plaintext.byteLength,
        authenticatedPartDigest,
      }),
    );
  });
  expect(completed).toMatchObject({ candidateState: "complete", resultState: "awaiting_order" });
  return resultId;
}

function recoverStorageQuotaGapAt(
  harness: IngressHarness,
  recoveredAtMs: number,
  decision: "proved_safe_discard" | "discard_and_close_source",
): void {
  vi.setSystemTime(recoveredAtMs - 1);
  const gapBytes = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      broker_route_id: harness.routeId,
      failure_code: "storage_quota",
      channel_position_observation_id: null,
      requested_position: null,
    }),
  );
  const gapDigest = digestBytes(gapBytes);
  harness.database.transaction((transaction) => {
    const evidence = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: harness.serverId,
      artifactSchemaId: A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
      artifactDigest: gapDigest,
      artifactBytes: ProtectedByteSnapshot.from(gapBytes),
    });
    return recordMutation(
      harness,
      transaction.ingress.latchStorageQuotaGap({
        ...coordinate(harness, `a17b1-storage-gap-${decision}`),
        evidenceRef: evidence.artifactRef.protectedHandleId,
        evidenceDigest: gapDigest,
      }),
    );
  });
  const gap = harness.database.ingress
    .readRouteState(harness.routeId)
    ?.gaps.find((candidate) => candidate.reason === "storage_quota" && candidate.state === "open");
  if (gap === undefined) throw new Error("storage-quota gap did not become durable");

  vi.setSystemTime(recoveredAtMs);
  const recoveryBytes = new TextEncoder().encode(
    JSON.stringify({ v: 1, recovery: decision, gap_id: gap.gapId }),
  );
  const recoveryDigest = digestBytes(recoveryBytes);
  harness.database.transaction((transaction) => {
    const evidence = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: harness.serverId,
      artifactSchemaId: A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
      artifactDigest: recoveryDigest,
      artifactBytes: ProtectedByteSnapshot.from(recoveryBytes),
    });
    return recordMutation(
      harness,
      transaction.ingress.recoverGap({
        ...coordinate(harness, `a17b1-storage-recover-${decision}`),
        gapId: gap.gapId,
        recoveryId: parseA1SafeId(`a17b1-storage-recovery-${decision}`),
        decision,
        evidenceRef: evidence.artifactRef.protectedHandleId,
        evidenceDigest: recoveryDigest,
      }),
    );
  });
}

interface CommandFixture {
  database: HostStateDatabase;
  readonly state: ReturnType<typeof temporaryState>;
  readonly harness: IngressHarness;
  readonly sourceIds: readonly ReturnType<typeof parseA1SafeId>[];
  readonly rootSecret: Uint8Array;
  readonly custody: ReturnType<typeof createServerKeyCustodySigner>;
  readonly signingLeaseId: ReturnType<typeof parseA1SafeId>;
  readonly signingLeaseFencingToken: number;
}

async function createCommandFixture(
  sourceCount = 1,
  routeKind: "chat" | "server_control" = "chat",
): Promise<CommandFixture> {
  const state = temporaryState();
  const database = openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: state.environment,
  });
  const rootSecret = new Uint8Array(32).fill(37);
  const custody = createServerKeyCustodySigner(rootSecret);
  try {
    const server = database.records.ensureDefaultCollaborationServer().server;
    const coordinator = database.records.acquireCoordinatorLease({
      collaborationServerId: server.collaborationServerId,
      candidateLeaseId: canonicalId("coordinatorLease", 38),
      ownerInstanceId: parseA1SafeId("a17b1-command-owner-1"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: LEASE_DURATION_MS,
    });
    const fence = {
      collaborationServerId: server.collaborationServerId,
      coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
      coordinatorEpoch: coordinator.lease.coordinatorEpoch,
    };
    const initialized = resumeInitialServerSigner({
      database,
      reopenDatabase: () =>
        openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        }),
      custody,
      machineIdentityId: MACHINE_IDENTITY_ID,
      collaborationServerId: server.collaborationServerId,
      coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
      coordinatorEpoch: coordinator.lease.coordinatorEpoch,
      bootstrapSigningLeaseId: parseA1SafeId("a17b1-bootstrap-signing-lease"),
      signingLeaseId: parseA1SafeId("a17b1-current-signing-lease-1"),
      signingKeyRef: canonicalId("protectedHandle", 39),
      scopeCertificateId: parseA1SafeId("a17b1-scope-certificate"),
      preparedAtMs: NOW_MS,
      issuedAtMs: NOW_MS,
      expectedServerSignatureSeq: 0,
      expectedFencingToken: 0,
    });
    expect(initialized).toMatchObject({
      signerWritable: true,
      finalization: {
        signingLease: { state: "current" },
        reservation: { signerSequence: 0, state: "signed" },
      },
    });
    const harness =
      routeKind === "chat"
        ? installIngressHarness(database, server.collaborationServerId, fence)
        : installServerControlIngressHarness(database, server.collaborationServerId, fence);
    const sourceIds: ReturnType<typeof parseA1SafeId>[] = [];
    for (let index = 0; index < sourceCount; index++) {
      sourceIds.push(await acceptIngressSource(harness, index, `source-${index + 1}`));
    }
    return {
      database,
      state,
      harness,
      sourceIds,
      rootSecret,
      custody,
      signingLeaseId: initialized.finalization.signingLease.signingLeaseId,
      signingLeaseFencingToken: initialized.finalization.signingLease.fencingToken,
    };
  } catch (error) {
    database.close();
    custody.close();
    rootSecret.fill(0);
    throw error;
  }
}

function closeFixture(fixture: CommandFixture): void {
  try {
    fixture.database.close();
  } finally {
    fixture.custody.close();
    fixture.rootSecret.fill(0);
  }
}

function currentServer(fixture: CommandFixture) {
  return fixture.database.records.ensureDefaultCollaborationServer().server;
}

function readyRequest(
  fixture: CommandFixture,
  sourceId = fixture.sourceIds[0],
): MaterializeReadyA1IngressCommandRequest {
  if (sourceId === undefined) throw new Error("command fixture has no accepted source");
  return {
    fence: fixture.harness.fence,
    stableSemanticResultId: sourceId,
    expectedReadyAtJournalSeq: currentServer(fixture).nextJournalOffset,
  };
}

function decisionRequest(
  fixture: CommandFixture,
  commandId: ReturnType<typeof parseA1SafeId>,
  overrides: Partial<ReserveRejectedCommandDecisionRequest> = {},
): ReserveRejectedCommandDecisionRequest {
  const server = currentServer(fixture);
  return {
    fence: fixture.harness.fence,
    expectedCommandId: commandId,
    expectedCommandSeq: server.nextCommandSeq,
    expectedSignerSequence: server.nextServerSignatureSeq,
    expectedSigningLeaseId: fixture.signingLeaseId,
    ...overrides,
  };
}

function reopenFixture(fixture: CommandFixture): HostStateDatabase {
  return openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: fixture.state.environment,
  });
}

function injectUnknownCommit<T>(
  outcome: "landed" | "absent",
  operation: () => T,
): HostStateCommitOutcomeUnknownError {
  const originalExec = DatabaseSync.prototype.exec;
  let armed = true;
  let commitFailed = false;
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    if (armed && sql === "COMMIT") {
      commitFailed = true;
      if (outcome === "landed") Reflect.apply(originalExec, this, [sql]);
      throw new Error(`simulated ${outcome} command COMMIT acknowledgement loss`);
    }
    if (armed && commitFailed && sql === "ROLLBACK") {
      throw new Error("simulated rollback proof failure");
    }
    return Reflect.apply(originalExec, this, [sql]);
  });
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  } finally {
    armed = false;
    exec.mockRestore();
  }
  expect(failure).toBeInstanceOf(HostStateCommitOutcomeUnknownError);
  return failure as HostStateCommitOutcomeUnknownError;
}

function commandGraphCounts(databasePath: string) {
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (table: string) =>
      (inspection.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
        .count;
    return {
      ready: count("command_ready_entries"),
      adjudications: count("a1_ingress_adjudications"),
      commands: count("collaboration_commands"),
      groups: count("collaboration_command_compound_signing_groups"),
      preparations: count("collaboration_command_result_preparations"),
      commandReservations: (
        inspection
          .prepare(
            `SELECT count(*) AS count FROM server_signature_reservations
              WHERE purpose = 'collaboration_command_result'`,
          )
          .get() as { count: number }
      ).count,
    };
  } finally {
    inspection.close();
  }
}

interface SignedCommandFixture extends CommandFixture {
  readonly sourceId: ReturnType<typeof parseA1SafeId>;
  readonly secondSourceId: ReturnType<typeof parseA1SafeId> | null;
  readonly commandId: ReturnType<typeof parseA1SafeId>;
  readonly commandResultPreparationId: ReturnType<typeof parseA1SafeId>;
  readonly commandPayloadRef: A1CanonicalId<"protectedHandle">;
  readonly decision: ReserveRejectedCommandDecisionRequest;
  successorFence: ReserveRejectedCommandDecisionRequest["fence"] | null;
}

function finalizationRequest(
  fixture: SignedCommandFixture,
  fence: ReserveRejectedCommandDecisionRequest["fence"] = fixture.decision.fence,
): FinalizeSignedRejectedCommandResultRequest {
  const retained = fixture.database.commandAdjudication.readState(fixture.sourceId);
  const commandResultId = retained?.preparation?.commandResultId;
  const signedRecordDigest = retained?.signatureReservation?.signedRecordDigest;
  if (
    commandResultId === undefined ||
    commandResultId === null ||
    signedRecordDigest === null ||
    signedRecordDigest === undefined
  ) {
    throw new Error("signed command fixture has no exact durable result identity and digest");
  }
  return {
    fence,
    expectedCommandId: fixture.commandId,
    expectedCommandResultId: commandResultId,
    expectedCommandResultPreparationId: fixture.commandResultPreparationId,
    expectedSignedRecordDigest: signedRecordDigest,
    expectedAcceptedAtJournalSeq: 1,
  };
}

async function createSignedCommandFixture(
  options: { readonly secondSource?: boolean; readonly takeoverBeforeDecision?: boolean } = {},
): Promise<SignedCommandFixture> {
  const fixture = await createCommandFixture(options.secondSource === true ? 2 : 1);
  const sourceId = fixture.sourceIds[0];
  if (sourceId === undefined) throw new Error("missing accepted command source");
  try {
    const ready = fixture.database.commandAdjudication.materializeReadyIngressCommand(
      readyRequest(fixture, sourceId),
    );
    let successorFence: ReserveRejectedCommandDecisionRequest["fence"] | null = null;
    let decisionSigningLeaseId = fixture.signingLeaseId;
    if (options.takeoverBeforeDecision === true) {
      fixture.database.records.releaseCoordinatorLease({ fence: fixture.harness.fence });
      vi.setSystemTime(NOW_MS + 1);
      const successor = fixture.database.records.acquireCoordinatorLease({
        collaborationServerId: fixture.harness.serverId,
        candidateLeaseId: canonicalId("coordinatorLease", 43),
        ownerInstanceId: parseA1SafeId("a17b1-corruption-owner-2"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: fixture.harness.fence.coordinatorEpoch,
        leaseDurationMs: LEASE_DURATION_MS,
      });
      successorFence = {
        collaborationServerId: fixture.harness.serverId,
        coordinatorLeaseId: successor.lease.coordinatorLeaseId,
        coordinatorEpoch: successor.lease.coordinatorEpoch,
      };
      decisionSigningLeaseId = parseA1SafeId("a17b1-corruption-signing-lease-2");
      acquireUsableServerSigningLease({
        database: fixture.database,
        reopenDatabase: () => reopenFixture(fixture),
        custody: fixture.custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        acquisition: {
          fence: successorFence,
          signingLeaseId: decisionSigningLeaseId,
          expectedCurrentSigningLeaseId: fixture.signingLeaseId,
          expectedFencingToken: fixture.signingLeaseFencingToken,
        },
      });
    }
    const decision = decisionRequest(fixture, ready.command.commandId, {
      ...(successorFence === null ? {} : { fence: successorFence }),
      expectedSigningLeaseId: decisionSigningLeaseId,
    });
    const reserved = fixture.database.commandAdjudication.reserveRejectedDecision(decision);
    reserved.canonicalPayload.destroy();
    const signed = signRejectedCommandResultPreparation({
      database: fixture.database,
      reopenDatabase: () => reopenFixture(fixture),
      custody: fixture.custody,
      machineIdentityId: MACHINE_IDENTITY_ID,
      decision,
    });
    return Object.assign(fixture, {
      sourceId,
      secondSourceId: fixture.sourceIds[1] ?? null,
      commandId: ready.command.commandId,
      commandResultPreparationId: signed.commandResultPreparationId,
      commandPayloadRef: ready.command.canonicalCommandPayloadRef,
      decision,
      successorFence,
    });
  } catch (error) {
    closeFixture(fixture);
    throw error;
  }
}

interface StoredTrigger {
  readonly name: string;
  readonly sql: string;
}

function mutateWithoutExactTriggers(
  databasePath: string,
  triggerNames: readonly string[],
  mutation: (editor: DatabaseSync) => void,
): void {
  const editor = new DatabaseSync(databasePath);
  let began = false;
  try {
    editor.exec("PRAGMA foreign_keys = ON");
    const triggers = triggerNames.map((name): StoredTrigger => {
      const row = editor
        .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get(name) as { name: string; sql: string } | undefined;
      if (row === undefined || typeof row.sql !== "string") {
        throw new Error(`missing exact corruption guard trigger ${name}`);
      }
      return row;
    });
    editor.exec("BEGIN IMMEDIATE");
    began = true;
    for (const trigger of triggers) {
      editor.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    }
    mutation(editor);
    for (const trigger of triggers) editor.exec(trigger.sql);
    editor.exec("COMMIT");
    began = false;
    for (const trigger of triggers) {
      expect(
        editor
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
          .get(trigger.name),
      ).toBeDefined();
    }
  } finally {
    if (began) {
      try {
        editor.exec("ROLLBACK");
      } catch {
        // The mutation failure remains primary.
      }
    }
    editor.close();
  }
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return messages.join("\ncaused by: ");
}

function expectSecureReopenRejected(
  fixture: CommandFixture,
  expectedCause: RegExp,
  expectedBoundary: RegExp = /command adjudication records failed semantic validation/,
): void {
  let unexpected: HostStateDatabase | undefined;
  let failure: unknown;
  try {
    unexpected = reopenFixture(fixture);
  } catch (error) {
    failure = error;
  } finally {
    unexpected?.close();
  }
  const chain = errorChain(failure);
  expect(chain).toMatch(expectedBoundary);
  expect(chain).toMatch(expectedCause);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.7b1 real SQLite command-adjudication integration", () => {
  it("persists an exact signed rejected preparation while leaving ingress and A1.8 dormant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createCommandFixture();
    const sourceId = fixture.sourceIds[0];
    if (sourceId === undefined) throw new Error("missing accepted ingress source");
    try {
      const ready = fixture.database.commandAdjudication.materializeReadyIngressCommand(
        readyRequest(fixture, sourceId),
      );
      const request = decisionRequest(fixture, ready.command.commandId);
      const reserved = fixture.database.commandAdjudication.reserveRejectedDecision(request);
      expect(reserved).toMatchObject({
        command: { state: "decision_reserved", disposition: "rejected", commandSeq: 0 },
        adjudication: { state: "deciding", disposition: "rejected", commandSeq: 0 },
        preparation: { state: "reserved", preparationGeneration: 1 },
        signingGroup: { state: "reserved" },
        signatureReservation: {
          purpose: "collaboration_command_result",
          signerSequence: 1,
          state: "reserved",
        },
      });
      reserved.canonicalPayload.destroy();
      const signed = signRejectedCommandResultPreparation({
        database: fixture.database,
        reopenDatabase: () => reopenFixture(fixture),
        custody: fixture.custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        decision: request,
      });
      expect(signed).toMatchObject({
        commandResultPreparationId: reserved.preparation.commandResultPreparationId,
        commandResultId: reserved.preparation.commandResultId,
        signerSequence: 1,
        signingLeaseId: fixture.signingLeaseId,
        preparationGeneration: 1,
        replayed: false,
        reconciledUnknownCommitCount: 0,
      });
      expect(fixture.database.commandAdjudication.readState(sourceId)).toMatchObject({
        command: { commandId: ready.command.commandId, state: "decision_reserved" },
        adjudication: { state: "deciding" },
        preparation: { state: "signed" },
        signingGroup: { state: "result_signed" },
        signatureReservation: { state: "signed" },
      });
      expect(
        fixture.database.ingress.readRouteState(fixture.harness.routeId)?.results,
      ).toMatchObject([{ stableSemanticResultId: sourceId, state: "awaiting_order" }]);
      fixture.database.close();

      const reopened = reopenFixture(fixture);
      try {
        expect(reopened.schemaVersion).toBe(11);
        expect(reopened.commandAdjudication.readState(sourceId)).toMatchObject({
          readyEntry: { commandId: ready.command.commandId },
          command: { state: "decision_reserved", disposition: "rejected", commandSeq: 0 },
          adjudication: { state: "deciding" },
          preparation: {
            commandResultPreparationId: signed.commandResultPreparationId,
            state: "signed",
          },
          signingGroup: { state: "result_signed" },
          signatureReservation: { signerSequence: 1, state: "signed" },
        });
        expect(reopened.ingress.readRouteState(fixture.harness.routeId)?.results).toMatchObject([
          { stableSemanticResultId: sourceId, state: "awaiting_order" },
        ]);
      } finally {
        reopened.close();
      }

      expect(commandGraphCounts(fixture.state.paths.databasePath)).toEqual({
        ready: 1,
        adjudications: 1,
        commands: 1,
        groups: 1,
        preparations: 1,
        commandReservations: 1,
      });
      const inspection = new DatabaseSync(fixture.state.paths.databasePath, { readOnly: true });
      try {
        for (const dormant of [
          "collaboration_command_results",
          "a1_ingress_terminal_results",
          "a1_ingress_result_deliveries",
        ]) {
          expect(
            inspection.prepare(`SELECT count(*) AS count FROM ${dormant}`).get(),
            dormant,
          ).toEqual({ count: 0 });
        }
        for (const forbidden of [
          "collaboration_command_result_deliveries",
          "collaboration_command_result_outbox",
          "ingress_result_deliveries",
          "host_output_deliveries",
          "native_dispatch_attempts",
          "command_effect_gates",
          "command_effect_attempts",
        ]) {
          expect(
            inspection
              .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
              .get(forbidden),
          ).toBeUndefined();
        }
        expect(
          (
            inspection
              .prepare(
                `SELECT count(*) AS count
                   FROM server_signed_record_acceptances AS acceptance
                   JOIN server_signature_reservations AS reservation
                     ON reservation.collaboration_server_id = acceptance.collaboration_server_id
                    AND reservation.signer_sequence = acceptance.signer_sequence
                  WHERE reservation.purpose = 'collaboration_command_result'`,
              )
              .get() as { count: number }
          ).count,
        ).toBe(0);
      } finally {
        inspection.close();
      }
    } finally {
      fixture.custody.close();
      fixture.rootSecret.fill(0);
    }
  });

  it("atomically finalizes one rejected result and securely reopens its inert pending-seal graph", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createSignedCommandFixture();
    const request = finalizationRequest(fixture);
    try {
      const finalized =
        fixture.database.commandAdjudication.finalizeSignedRejectedCommandResult(request);
      expect(finalized).toMatchObject({
        command: { state: "decided", currentCommandResultId: request.expectedCommandResultId },
        adjudication: { state: "terminal", disposition: "rejected" },
        commonResult: {
          commandResultId: request.expectedCommandResultId,
          disposition: "rejected",
          acceptedAtJournalSeq: 1,
        },
        signerAcceptance: { acceptedAtJournalSeq: 1, historicalReattestationId: null },
        terminalResult: {
          stableSemanticResultId: fixture.sourceId,
          semanticResultRecordKind: "action_result",
          adjudicationState: "terminal",
        },
        resultDelivery: {
          stableSemanticResultId: fixture.sourceId,
          targetKind: "a1_broker",
          targetRef: fixture.harness.routeId,
          state: "pending_seal",
        },
        replayed: false,
      });
      expect(
        fixture.database.ingress.readRouteState(fixture.harness.routeId)?.results,
      ).toMatchObject([{ stableSemanticResultId: fixture.sourceId, state: "awaiting_order" }]);

      const terminalPayloadRef = finalized.terminalResult.semanticResultPayloadRef;
      fixture.database.close();
      const inspection = new DatabaseSync(fixture.state.paths.databasePath, { readOnly: true });
      try {
        const source = inspection
          .prepare(
            `SELECT message_id, record_kind, state FROM authenticated_ingress_results
              WHERE stable_semantic_result_id = ?`,
          )
          .get(fixture.sourceId) as {
          message_id: string;
          record_kind: string;
          state: string;
        };
        const artifact = inspection
          .prepare(
            `SELECT artifact_schema_id, artifact_bytes FROM protected_artifacts
              WHERE protected_handle_id = ?`,
          )
          .get(terminalPayloadRef) as { artifact_schema_id: string; artifact_bytes: Uint8Array };
        expect(source).toMatchObject({ record_kind: "user", state: "awaiting_order" });
        expect(artifact.artifact_schema_id).toBe("remote-claw/a1-action-result/v1");
        expect(Buffer.from(artifact.artifact_bytes).toString("utf8")).toBe(
          `{"v":1,"result_id":"${fixture.sourceId}","source_msg_id":"${source.message_id}","source_record_kind":"user","decision":"rejected","command_seq":0}`,
        );
        expect(
          inspection
            .prepare(
              `SELECT count(*) AS count FROM server_signed_record_acceptances AS acceptance
                JOIN server_signature_reservations AS reservation
                  ON reservation.collaboration_server_id = acceptance.collaboration_server_id
                 AND reservation.signer_sequence = acceptance.signer_sequence
               WHERE reservation.purpose = 'collaboration_command_result'`,
            )
            .get(),
        ).toEqual({ count: 1 });
        for (const table of [
          "collaboration_command_results",
          "a1_ingress_terminal_results",
          "a1_ingress_result_deliveries",
        ]) {
          expect(inspection.prepare(`SELECT count(*) AS count FROM ${table}`).get(), table).toEqual(
            {
              count: 1,
            },
          );
        }
      } finally {
        inspection.close();
      }

      fixture.database = reopenFixture(fixture);
      expect(
        fixture.database.commandAdjudication.reconcileFinalizedRejectedCommandResult(request),
      ).toMatchObject({
        commonResult: { commandResultId: request.expectedCommandResultId },
        resultDelivery: { state: "pending_seal" },
        replayed: true,
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("accepts an exact predecessor signature after takeover and then unblocks the successor signer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createSignedCommandFixture();
    try {
      fixture.database.records.releaseCoordinatorLease({ fence: fixture.decision.fence });
      vi.setSystemTime(NOW_MS + 1);
      const successor = fixture.database.records.acquireCoordinatorLease({
        collaborationServerId: fixture.harness.serverId,
        candidateLeaseId: canonicalId("coordinatorLease", 223),
        ownerInstanceId: parseA1SafeId("a18a0-finalization-owner-2"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: fixture.decision.fence.coordinatorEpoch,
        leaseDurationMs: LEASE_DURATION_MS,
      });
      const successorFence = {
        collaborationServerId: fixture.harness.serverId,
        coordinatorLeaseId: successor.lease.coordinatorLeaseId,
        coordinatorEpoch: successor.lease.coordinatorEpoch,
      };
      const request = finalizationRequest(fixture, successorFence);
      expect(
        fixture.database.commandAdjudication.finalizeSignedRejectedCommandResult(request),
      ).toMatchObject({
        commonResult: { signedRecordDigest: request.expectedSignedRecordDigest },
        terminalResult: {
          finalizationCoordinatorLeaseId: successorFence.coordinatorLeaseId,
          finalizationCoordinatorEpoch: successorFence.coordinatorEpoch,
        },
        signerAcceptance: { historicalReattestationId: null },
        resultDelivery: { state: "pending_seal" },
      });

      const successorSigningLeaseId = parseA1SafeId("a18a0-current-signing-lease-2");
      expect(
        acquireUsableServerSigningLease({
          database: fixture.database,
          reopenDatabase: () => reopenFixture(fixture),
          custody: fixture.custody,
          machineIdentityId: MACHINE_IDENTITY_ID,
          acquisition: {
            fence: successorFence,
            signingLeaseId: successorSigningLeaseId,
            expectedCurrentSigningLeaseId: fixture.signingLeaseId,
            expectedFencingToken: fixture.signingLeaseFencingToken,
          },
        }),
      ).toMatchObject({
        acquisition: {
          predecessor: { signingLeaseId: fixture.signingLeaseId, state: "superseded" },
          signingLease: {
            signingLeaseId: successorSigningLeaseId,
            state: "current",
            acquiredAtMs: NOW_MS + 2,
          },
        },
      });

      fixture.database.close();
      fixture.database = reopenFixture(fixture);
      expect(
        fixture.database.commandAdjudication.reconcileFinalizedRejectedCommandResult(request),
      ).toMatchObject({ replayed: true, resultDelivery: { state: "pending_seal" } });
    } finally {
      closeFixture(fixture);
    }
  });

  it.each([
    "landed",
    "absent",
  ] as const)("settles an unknown ready-materialization COMMIT proved %s before retry", async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createCommandFixture();
    const sourceId = fixture.sourceIds[0];
    if (sourceId === undefined) throw new Error("missing accepted ingress source");
    try {
      const request = readyRequest(fixture, sourceId);
      const failure = injectUnknownCommit(outcome, () =>
        fixture.database.commandAdjudication.materializeReadyIngressCommand(request),
      );
      expect(failure).toMatchObject({ outcome: "unknown", retrySafe: false });
      expect(() => fixture.database.transaction(() => undefined)).toThrow(/poisoned/);
      fixture.database.close();
      fixture.database = reopenFixture(fixture);

      const observed = fixture.database.commandAdjudication.reconcileReadyIngressCommand(request);
      if (outcome === "landed") {
        expect(observed).toMatchObject({
          readyEntry: {
            stableSemanticResultId: sourceId,
            readyAtJournalSeq: request.expectedReadyAtJournalSeq,
          },
          command: { state: "awaiting_order" },
          adjudication: { state: "awaiting_order" },
          replayed: true,
        });
      } else {
        expect(observed).toBeNull();
      }
      const settled =
        observed ?? fixture.database.commandAdjudication.materializeReadyIngressCommand(request);
      const exactReplay =
        fixture.database.commandAdjudication.materializeReadyIngressCommand(request);
      expect(exactReplay).toEqual({ ...settled, replayed: true });
      expect(currentServer(fixture)).toMatchObject({
        nextJournalOffset: request.expectedReadyAtJournalSeq + 1,
        nextCommandSeq: 0,
        nextServerSignatureSeq: 1,
      });
      expect(commandGraphCounts(fixture.state.paths.databasePath)).toEqual({
        ready: 1,
        adjudications: 1,
        commands: 1,
        groups: 0,
        preparations: 0,
        commandReservations: 0,
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it.each([
    "landed",
    "absent",
  ] as const)("settles an unknown rejected-decision COMMIT proved %s without sequence gaps", async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createCommandFixture();
    const sourceId = fixture.sourceIds[0];
    if (sourceId === undefined) throw new Error("missing accepted ingress source");
    try {
      const ready = fixture.database.commandAdjudication.materializeReadyIngressCommand(
        readyRequest(fixture, sourceId),
      );
      const request = decisionRequest(fixture, ready.command.commandId);
      injectUnknownCommit(outcome, () =>
        fixture.database.commandAdjudication.reserveRejectedDecision(request),
      );
      fixture.database.close();
      fixture.database = reopenFixture(fixture);

      const observed = fixture.database.commandAdjudication.reconcileRejectedDecision(request);
      if (outcome === "landed") {
        expect(observed).toMatchObject({
          command: { commandSeq: 0, disposition: "rejected", state: "decision_reserved" },
          preparation: { preparationGeneration: 1, state: "reserved" },
          signatureReservation: { signerSequence: 1, state: "reserved" },
          replayed: true,
        });
        observed?.canonicalPayload.destroy();
      } else {
        expect(observed).toBeNull();
      }
      const settled =
        observed ?? fixture.database.commandAdjudication.reserveRejectedDecision(request);
      const preparationId = settled.preparation.commandResultPreparationId;
      const resultId = settled.preparation.commandResultId;
      if (observed === null) settled.canonicalPayload.destroy();
      const exactReplay = fixture.database.commandAdjudication.reserveRejectedDecision(request);
      expect(exactReplay).toMatchObject({
        preparation: {
          commandResultPreparationId: preparationId,
          commandResultId: resultId,
          preparationGeneration: 1,
        },
        signatureReservation: { signerSequence: 1 },
        replayed: true,
      });
      exactReplay.canonicalPayload.destroy();
      expect(currentServer(fixture)).toMatchObject({
        nextCommandSeq: 1,
        nextServerSignatureSeq: 2,
      });
      expect(commandGraphCounts(fixture.state.paths.databasePath)).toEqual({
        ready: 1,
        adjudications: 1,
        commands: 1,
        groups: 1,
        preparations: 1,
        commandReservations: 1,
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("advances a same-route head, enforces global order, and preserves split-time takeover provenance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createCommandFixture(2);
    const firstSourceId = fixture.sourceIds[0];
    const secondSourceId = fixture.sourceIds[1];
    if (firstSourceId === undefined || secondSourceId === undefined) {
      throw new Error("missing accepted same-route sources");
    }
    try {
      const first = fixture.database.commandAdjudication.materializeReadyIngressCommand(
        readyRequest(fixture, firstSourceId),
      );
      const second = fixture.database.commandAdjudication.materializeReadyIngressCommand(
        readyRequest(fixture, secondSourceId),
      );
      expect(second).toMatchObject({
        readyEntry: {
          stableSemanticResultId: secondSourceId,
          readyAtJournalSeq: first.readyEntry.readyAtJournalSeq + 1,
        },
        command: { sourceRef: secondSourceId, state: "awaiting_order" },
      });
      expect(() =>
        fixture.database.commandAdjudication.reserveRejectedDecision(
          decisionRequest(fixture, second.command.commandId),
        ),
      ).toThrow(/server-wide ready-order head/);

      fixture.database.records.releaseCoordinatorLease({ fence: fixture.harness.fence });
      vi.setSystemTime(NOW_MS + 1);
      const successor = fixture.database.records.acquireCoordinatorLease({
        collaborationServerId: fixture.harness.serverId,
        candidateLeaseId: canonicalId("coordinatorLease", 42),
        ownerInstanceId: parseA1SafeId("a17b1-command-owner-2"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: fixture.harness.fence.coordinatorEpoch,
        leaseDurationMs: LEASE_DURATION_MS,
      });
      const successorFence = {
        collaborationServerId: fixture.harness.serverId,
        coordinatorLeaseId: successor.lease.coordinatorLeaseId,
        coordinatorEpoch: successor.lease.coordinatorEpoch,
      };
      const successorSigningLeaseId = parseA1SafeId("a17b1-current-signing-lease-2");
      const acquired = acquireUsableServerSigningLease({
        database: fixture.database,
        reopenDatabase: () => reopenFixture(fixture),
        custody: fixture.custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        acquisition: {
          fence: successorFence,
          signingLeaseId: successorSigningLeaseId,
          expectedCurrentSigningLeaseId: fixture.signingLeaseId,
          expectedFencingToken: fixture.signingLeaseFencingToken,
        },
      });
      expect(acquired).toMatchObject({
        acquisition: {
          predecessor: { signingLeaseId: fixture.signingLeaseId, state: "superseded" },
          signingLease: { signingLeaseId: successorSigningLeaseId, state: "current" },
        },
      });
      const request = decisionRequest(fixture, first.command.commandId, {
        fence: successorFence,
        expectedSigningLeaseId: successorSigningLeaseId,
      });
      const reserved = fixture.database.commandAdjudication.reserveRejectedDecision(request);
      expect(reserved.command).toMatchObject({
        coordinatorLeaseId: fixture.harness.fence.coordinatorLeaseId,
        coordinatorEpoch: 1,
        decisionCoordinatorLeaseId: successorFence.coordinatorLeaseId,
        decisionCoordinatorEpoch: 2,
        createdAtMs: NOW_MS,
        decidedAtMs: NOW_MS + 1,
      });
      reserved.canonicalPayload.destroy();
      signRejectedCommandResultPreparation({
        database: fixture.database,
        reopenDatabase: () => reopenFixture(fixture),
        custody: fixture.custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        decision: request,
      });
      fixture.database.close();
      fixture.database = reopenFixture(fixture);
      expect(fixture.database.commandAdjudication.readState(firstSourceId)).toMatchObject({
        command: { commandSeq: 0, decisionCoordinatorEpoch: 2 },
        preparation: { state: "signed", signingLeaseId: successorSigningLeaseId },
      });
      expect(fixture.database.commandAdjudication.readState(secondSourceId)).toMatchObject({
        command: { commandSeq: null, state: "awaiting_order" },
        preparation: null,
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("retains a legal epoch-two abort of an epoch-one bound preparation across secure reopen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createCommandFixture();
    const sourceId = fixture.sourceIds[0];
    if (sourceId === undefined) throw new Error("missing accepted ingress source");
    try {
      const ready = fixture.database.commandAdjudication.materializeReadyIngressCommand(
        readyRequest(fixture, sourceId),
      );
      const decision = decisionRequest(fixture, ready.command.commandId);
      const reserved = fixture.database.commandAdjudication.reserveRejectedDecision(decision);
      reserved.canonicalPayload.destroy();
      const bound = fixture.database.commandAdjudication.bindRejectedResultPreparation({
        fence: fixture.harness.fence,
        commandResultPreparationId: reserved.preparation.commandResultPreparationId,
      });
      expect(bound).toMatchObject({
        preparation: { state: "bound", boundAtMs: NOW_MS },
        signingGroup: { state: "reserved" },
        signatureReservation: { state: "bound" },
      });

      fixture.database.records.releaseCoordinatorLease({ fence: fixture.harness.fence });
      vi.setSystemTime(NOW_MS + 1);
      const successor = fixture.database.records.acquireCoordinatorLease({
        collaborationServerId: fixture.harness.serverId,
        candidateLeaseId: canonicalId("coordinatorLease", 44),
        ownerInstanceId: parseA1SafeId("a17b1-abort-owner-2"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: fixture.harness.fence.coordinatorEpoch,
        leaseDurationMs: LEASE_DURATION_MS,
      });
      const successorFence = {
        collaborationServerId: fixture.harness.serverId,
        coordinatorLeaseId: successor.lease.coordinatorLeaseId,
        coordinatorEpoch: successor.lease.coordinatorEpoch,
      };
      const aborted = fixture.database.commandAdjudication.abortRejectedResultPreparation({
        fence: successorFence,
        commandResultPreparationId: reserved.preparation.commandResultPreparationId,
      });
      expect(aborted).toMatchObject({
        preparation: { state: "aborted", abortedAtMs: NOW_MS + 1 },
        signingGroup: { state: "aborted", abortedAtMs: NOW_MS + 1 },
        signatureReservation: { state: "aborted", abortedAtMs: NOW_MS + 1 },
      });
      fixture.database.close();
      fixture.database = reopenFixture(fixture);
      expect(fixture.database.commandAdjudication.readState(sourceId)).toMatchObject({
        command: { commandSeq: 0, state: "decision_reserved" },
        adjudication: {
          state: "deciding",
          commandResultPreparationId: reserved.preparation.commandResultPreparationId,
        },
        preparation: { state: "aborted", abortedAtMs: NOW_MS + 1 },
        signingGroup: { state: "aborted" },
        signatureReservation: { state: "aborted" },
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("clamps ready-command and payload timestamps to the durable recovered-route watermark", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createCommandFixture();
    const sourceId = fixture.sourceIds[0];
    if (sourceId === undefined) throw new Error("missing accepted ingress source");
    const recoveredAtMs = NOW_MS + 100;
    try {
      recoverStorageQuotaGapAt(fixture.harness, recoveredAtMs, "proved_safe_discard");
      expect(
        fixture.database.ingress.readRouteState(fixture.harness.routeId)?.runtime,
      ).toMatchObject({ state: "current", activeGapCount: 0, updatedAtMs: recoveredAtMs });
      vi.setSystemTime(recoveredAtMs - 1);
      const ready = fixture.database.commandAdjudication.materializeReadyIngressCommand(
        readyRequest(fixture, sourceId),
      );
      expect(ready).toMatchObject({
        readyEntry: { readyAtMs: recoveredAtMs },
        command: { createdAtMs: recoveredAtMs, state: "awaiting_order" },
      });
      const inspection = new DatabaseSync(fixture.state.paths.databasePath, { readOnly: true });
      try {
        expect(
          inspection
            .prepare(
              `SELECT created_at_ms FROM protected_artifacts
                WHERE protected_handle_id = ?`,
            )
            .get(ready.command.canonicalCommandPayloadRef),
        ).toEqual({ created_at_ms: recoveredAtMs });
      } finally {
        inspection.close();
      }
      fixture.database.close();
      fixture.database = reopenFixture(fixture);
      expect(fixture.database.commandAdjudication.readState(sourceId)).toMatchObject({
        readyEntry: { readyAtMs: recoveredAtMs },
        command: { createdAtMs: recoveredAtMs, state: "awaiting_order" },
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("rejects trigger-restored command timestamps that postdate a closed source route", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createSignedCommandFixture();
    const routeClosedAtMs = NOW_MS + 200;
    recoverStorageQuotaGapAt(fixture.harness, routeClosedAtMs, "discard_and_close_source");
    expect(fixture.database.ingress.readRouteState(fixture.harness.routeId)?.runtime).toMatchObject(
      {
        state: "closed",
        activeGapCount: 0,
        updatedAtMs: routeClosedAtMs,
      },
    );
    fixture.database.close();
    fixture.database = reopenFixture(fixture);
    fixture.database.close();
    try {
      const corruptObservedAtMs = routeClosedAtMs + 1;
      mutateWithoutExactTriggers(
        fixture.state.paths.databasePath,
        [
          "command_ready_entries_no_update",
          "collaboration_commands_require_rejected_decision",
          "a1_ingress_adjudications_require_deciding_transition",
        ],
        (editor) => {
          expect(
            Number(
              editor
                .prepare("UPDATE command_ready_entries SET ready_at_ms = ? WHERE command_id = ?")
                .run(corruptObservedAtMs, fixture.commandId).changes,
            ),
          ).toBe(1);
          expect(
            Number(
              editor
                .prepare(
                  `UPDATE collaboration_commands
                      SET created_at_ms = ?, decided_at_ms = ? WHERE command_id = ?`,
                )
                .run(corruptObservedAtMs, corruptObservedAtMs, fixture.commandId).changes,
            ),
          ).toBe(1);
          expect(
            Number(
              editor
                .prepare(
                  `UPDATE a1_ingress_adjudications SET decided_at_ms = ?
                    WHERE command_id = ?`,
                )
                .run(corruptObservedAtMs, fixture.commandId).changes,
            ),
          ).toBe(1);
        },
      );
      expectSecureReopenRejected(fixture, /command lifecycle postdates the closed source route/);
    } finally {
      fixture.custody.close();
      fixture.rootSecret.fill(0);
    }
  });

  it("rejects a trigger-restored server-control head with a non-null target chat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createCommandFixture(1, "server_control");
    const sourceId = fixture.sourceIds[0];
    if (sourceId === undefined) throw new Error("missing accepted server-control source");
    try {
      const ready = fixture.database.commandAdjudication.materializeReadyIngressCommand(
        readyRequest(fixture, sourceId),
      );
      expect(ready).toMatchObject({
        command: {
          scopeKind: "server_control",
          logicalChatId: null,
          targetLogicalChatId: null,
          mutationFamily: "new_chat",
          disposition: null,
          state: "awaiting_order",
        },
        adjudication: { state: "awaiting_order" },
      });
      fixture.database.close();
      mutateWithoutExactTriggers(
        fixture.state.paths.databasePath,
        ["collaboration_commands_require_rejected_decision"],
        (editor) => {
          editor.exec("PRAGMA ignore_check_constraints = ON");
          try {
            expect(
              Number(
                editor
                  .prepare(
                    `UPDATE collaboration_commands SET target_logical_chat_id = ?
                      WHERE command_id = ?`,
                  )
                  .run(canonicalId("logicalChat", 222), ready.command.commandId).changes,
              ),
            ).toBe(1);
          } finally {
            editor.exec("PRAGMA ignore_check_constraints = OFF");
          }
        },
      );
      expectSecureReopenRejected(
        fixture,
        /collaborationCommand server-control target requires an admitted decision/,
      );
    } finally {
      fixture.custody.close();
      fixture.rootSecret.fill(0);
    }
  });

  it("rejects linked creation timestamps moved after the frozen decision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createSignedCommandFixture();
    const retained = fixture.database.commandAdjudication.readState(fixture.sourceId);
    const decidedAtMs = retained?.command.decidedAtMs;
    if (decidedAtMs === null || decidedAtMs === undefined) {
      throw new Error("signed fixture has no frozen decision time");
    }
    const invertedCreatedAtMs = decidedAtMs + 1;
    fixture.database.close();
    try {
      mutateWithoutExactTriggers(
        fixture.state.paths.databasePath,
        [
          "command_ready_entries_no_update",
          "collaboration_commands_require_rejected_decision",
          "protected_artifacts_no_update",
        ],
        (editor) => {
          editor.exec("PRAGMA ignore_check_constraints = ON");
          try {
            expect(
              Number(
                editor
                  .prepare("UPDATE command_ready_entries SET ready_at_ms = ? WHERE command_id = ?")
                  .run(invertedCreatedAtMs, fixture.commandId).changes,
              ),
            ).toBe(1);
            expect(
              Number(
                editor
                  .prepare(
                    "UPDATE collaboration_commands SET created_at_ms = ? WHERE command_id = ?",
                  )
                  .run(invertedCreatedAtMs, fixture.commandId).changes,
              ),
            ).toBe(1);
            expect(
              Number(
                editor
                  .prepare(
                    `UPDATE protected_artifacts SET created_at_ms = ?
                      WHERE protected_handle_id = ?`,
                  )
                  .run(invertedCreatedAtMs, fixture.commandPayloadRef).changes,
              ),
            ).toBe(1);
          } finally {
            editor.exec("PRAGMA ignore_check_constraints = OFF");
          }
        },
      );
      expectSecureReopenRejected(
        fixture,
        /collaborationCommand decision predates command creation/,
      );
    } finally {
      fixture.custody.close();
      fixture.rootSecret.fill(0);
    }
  });

  it.each([
    {
      label: "high nextCommandSeq",
      secondSource: false,
      takeover: false,
      triggers: ["collaboration_servers_command_sequence_monotonic"],
      expected: /server command sequence is high, low, gapped, or violates global ready order/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        const result = editor
          .prepare(
            `UPDATE collaboration_servers SET next_command_seq = 2
              WHERE collaboration_server_id = ?`,
          )
          .run(fixture.harness.serverId);
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "low nextCommandSeq",
      secondSource: false,
      takeover: false,
      triggers: ["collaboration_servers_command_sequence_monotonic"],
      expected: /server command sequence is high, low, gapped, or violates global ready order/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        const result = editor
          .prepare(
            `UPDATE collaboration_servers SET next_command_seq = 0
              WHERE collaboration_server_id = ?`,
          )
          .run(fixture.harness.serverId);
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "canonical payload bytes",
      secondSource: false,
      takeover: false,
      triggers: ["protected_artifacts_no_update"],
      expected: /known command artifact digest is invalid/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        const row = editor
          .prepare("SELECT byte_length FROM protected_artifacts WHERE protected_handle_id = ?")
          .get(fixture.commandPayloadRef) as { byte_length: number };
        const result = editor
          .prepare(
            "UPDATE protected_artifacts SET artifact_bytes = ? WHERE protected_handle_id = ?",
          )
          .run(Buffer.alloc(row.byte_length, 0xa5), fixture.commandPayloadRef);
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "canonical payload digest binding",
      secondSource: false,
      takeover: false,
      triggers: ["collaboration_commands_require_rejected_decision"],
      expected: /canonical command payload artifact coordinates or digest are inconsistent/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        const result = editor
          .prepare(
            `UPDATE collaboration_commands SET canonical_command_payload_digest = ?
              WHERE command_id = ?`,
          )
          .run(base64urlEncode(new Uint8Array(32).fill(201)), fixture.commandId);
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "source swap",
      secondSource: true,
      takeover: false,
      triggers: ["collaboration_commands_require_rejected_decision"],
      expected: /command ready\/source\/sidecar graph is partial or swapped/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        if (fixture.secondSourceId === null) throw new Error("missing swap source");
        const result = editor
          .prepare("UPDATE collaboration_commands SET source_ref = ? WHERE command_id = ?")
          .run(fixture.secondSourceId, fixture.commandId);
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "user-ingress mutation family mismatch",
      secondSource: false,
      takeover: false,
      triggers: ["collaboration_commands_require_rejected_decision"],
      expected: /collaborationCommand\.mutationFamily is not a selected value/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        expect(
          editor
            .prepare("SELECT mutation_family FROM collaboration_commands WHERE command_id = ?")
            .get(fixture.commandId),
        ).toEqual({ mutation_family: "user_text" });
        const result = editor
          .prepare(
            "UPDATE collaboration_commands SET mutation_family = 'steer_text' WHERE command_id = ?",
          )
          .run(fixture.commandId);
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "decision coordinator fence",
      secondSource: false,
      takeover: true,
      triggers: ["collaboration_commands_require_rejected_decision"],
      expected:
        /command decision (has no exact coordinator history|lies outside its coordinator lifetime)/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        if (fixture.successorFence === null) throw new Error("missing successor decision fence");
        const result = editor
          .prepare(
            `UPDATE collaboration_commands
                SET decision_coordinator_lease_id = ?, decision_coordinator_epoch = ?
              WHERE command_id = ?`,
          )
          .run(
            fixture.harness.fence.coordinatorLeaseId,
            fixture.harness.fence.coordinatorEpoch,
            fixture.commandId,
          );
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "command-result signature",
      secondSource: false,
      takeover: false,
      triggers: ["server_signature_reservations_lifecycle_monotonic"],
      expected: /command result signature does not verify under the reserved key/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        const result = editor
          .prepare(
            `UPDATE server_signature_reservations SET signature = ?
              WHERE collaboration_server_id = ? AND signer_sequence = ?`,
          )
          .run(
            base64urlEncode(new Uint8Array(64).fill(202)),
            fixture.harness.serverId,
            fixture.decision.expectedSignerSequence,
          );
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "preparation generation edge",
      secondSource: false,
      takeover: false,
      triggers: ["collaboration_command_groups_lifecycle_monotonic"],
      expected: /result preparation generation graph is noncanonical/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        const result = editor
          .prepare(
            `UPDATE collaboration_command_compound_signing_groups
                SET preparation_generation = 2
              WHERE command_id = ?`,
          )
          .run(fixture.commandId);
        expect(Number(result.changes)).toBe(1);
      },
    },
    {
      label: "orphan known command artifact",
      secondSource: false,
      takeover: false,
      triggers: ["protected_artifacts_no_replace"],
      expected: /known command protected artifact is orphaned/,
      mutate(editor: DatabaseSync, fixture: SignedCommandFixture) {
        const orphanRef = canonicalId("protectedHandle", 250);
        const result = editor
          .prepare(
            `INSERT INTO protected_artifacts
               (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
                artifact_digest, byte_length, artifact_bytes, created_at_ms)
             SELECT ?, kind, scope_kind, scope_id, artifact_schema_id,
                    artifact_digest, byte_length, artifact_bytes, created_at_ms
               FROM protected_artifacts WHERE protected_handle_id = ?`,
          )
          .run(orphanRef, fixture.commandPayloadRef);
        expect(Number(result.changes)).toBe(1);
      },
    },
  ])("rejects trigger-restored $label corruption on secure reopen", async (testCase) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createSignedCommandFixture({
      secondSource: testCase.secondSource,
      takeoverBeforeDecision: testCase.takeover,
    });
    fixture.database.close();
    try {
      mutateWithoutExactTriggers(fixture.state.paths.databasePath, testCase.triggers, (editor) =>
        testCase.mutate(editor, fixture),
      );
      expectSecureReopenRejected(fixture, testCase.expected);
    } finally {
      fixture.custody.close();
      fixture.rootSecret.fill(0);
    }
  });
});
