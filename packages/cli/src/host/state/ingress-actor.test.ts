import {
  type A1BrokerRoute,
  type A1EncryptedFrameV2,
  type A1FrameHeaderV2,
  a1BrokerGenerationManifestDigest,
  base64urlEncode,
  deriveA1BrokerRouteId,
  encodeA1EncryptedFrameV2,
  parseA1BrokerCanonicalFrameV1,
  sealA1FramePartWith,
} from "@remote-claw/clawsec";
import { describe, expect, it, vi } from "vitest";
import type {
  InternalA1BrokerEvidenceReader,
  InternalA1BrokerReadEvidencePageV1,
} from "../../broker/a1-client.js";
import { A1BrokerOutcomeUnknownError, A1BrokerProtocolError } from "../../broker/a1-client.js";
import {
  type BrokerRouteId,
  deriveBrokerRouteId,
  parseBrokerRouteStoreInstanceId,
} from "./broker-route.js";
import type {
  A1Digest,
  A1SafeId,
  CollaborationServerId,
  CoordinatorLeaseId,
  LogicalChatId,
  ProtectedHandleId,
} from "./ids.js";
import {
  a1IngressRouteFromScope,
  createDormantA1IngressRouteActor,
  type DormantA1IngressRouteActorOptions,
  type DormantIngressDatabase,
  type DormantIngressTransaction,
  inspectPendingIngressFrame,
  prepareIngressEvidencePage,
  readIngressEvidencePage,
  runBoundedIngressRouteScheduler,
} from "./ingress-actor.js";
import type {
  BrokerRouteActorScope,
  IngressMutationResult,
  IngressPositionClassification,
  IngressRepositoryOperations,
  IngressRouteActorRecord,
  IngressRouteState,
  PendingIngressPosition,
} from "./ingress-repository.js";
import { IngressRepositoryQuotaError } from "./ingress-repository.js";
import { ProtectedByteSnapshot } from "./protected.js";
import { HostStateCommitOutcomeUnknownError } from "./sqlite.js";

const IDENTITY = "11".repeat(16);
const IDENTITY_BYTES = Uint8Array.from(Buffer.from(IDENTITY, "hex"));
const SERVER = `rcs_${base64urlEncode(new Uint8Array(16).fill(2))}` as CollaborationServerId;
const CHAT = `rcl_${base64urlEncode(new Uint8Array(16).fill(3))}` as LogicalChatId;
const ATTEMPT = `rda_${base64urlEncode(new Uint8Array(16).fill(4))}`;
const KEY = new Uint8Array(32).fill(5);
const SALT = new Uint8Array(32).fill(6);
const NONCE = new Uint8Array(12).fill(7);
const ZERO_DIGEST = base64urlEncode(new Uint8Array(32)) as A1Digest;
const LEASE = `rccl_${base64urlEncode(new Uint8Array(16).fill(11))}` as CoordinatorLeaseId;

function scope(overrides: Partial<BrokerRouteActorScope> = {}): BrokerRouteActorScope {
  const brokerRouteId = deriveBrokerRouteId(IDENTITY, SERVER, "chat", CHAT);
  return {
    brokerRouteId,
    collaborationServerId: SERVER,
    routeKind: "chat",
    logicalChatId: CHAT,
    ...overrides,
  } as BrokerRouteActorScope;
}

function header(overrides: Partial<A1FrameHeaderV2> = {}): A1FrameHeaderV2 {
  return {
    v: 2,
    identityId: IDENTITY_BYTES,
    collaborationServerId: SERVER,
    logicalChatId: CHAT,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: "source.msg-1",
    deliveryAttemptId: ATTEMPT,
    clientMsgId: "client.msg-1",
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

async function canonicalFrame(
  plaintext = new TextEncoder().encode('{"v":1,"text":"hello"}'),
  overrides: Partial<A1FrameHeaderV2> = {},
): Promise<Readonly<{ raw: string; frame: A1EncryptedFrameV2; digest: A1Digest }>> {
  const sealed = await sealA1FramePartWith(KEY, header(overrides), plaintext, SALT, NONCE);
  const frame = { ...sealed, hostSignature: null };
  const raw = encodeA1EncryptedFrameV2(frame);
  return {
    raw,
    frame,
    digest: (await parseA1BrokerCanonicalFrameV1(raw)).transportFrameDigest as A1Digest,
  };
}

function evidencePage(
  selected: BrokerRouteActorScope,
  frames: InternalA1BrokerReadEvidencePageV1["frames"],
): InternalA1BrokerReadEvidencePageV1 {
  return {
    schemaVersion: 1,
    brokerRouteId: selected.brokerRouteId,
    routeStoreInstanceId: `rbsi_${base64urlEncode(new Uint8Array(16).fill(10))}`,
    requestedPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
    generation: {
      schemaVersion: 1,
      brokerRouteId: selected.brokerRouteId,
      channelGeneration: 0,
      state: "open",
      frameCount: null,
      nextGeneration: null,
      manifestDigest: null,
    },
    observedNextFrameIndex: frames.length,
    frames,
    nextPosition: { version: 1, channelGeneration: 0, nextFrameIndex: frames.length },
    atLiveTail: true,
  };
}

function pending(_route: BrokerRouteId): PendingIngressPosition {
  return {
    channelPositionObservationId: `rcp_${base64urlEncode(new Uint8Array(32).fill(8))}` as A1SafeId,
    cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
    receivedFrameRef: `rcph_${base64urlEncode(new Uint8Array(16).fill(9))}` as never,
    receivedFrameDigest: ZERO_DIGEST,
    receivedFrameByteLength: 0,
    claimedDeliveryAttemptId: ATTEMPT as A1SafeId,
    claimedPart: 0,
    claimedTransportFrameDigest: ZERO_DIGEST,
  };
}

function fakeActorRecord(selected: BrokerRouteActorScope, revision = 0): IngressRouteActorRecord {
  return {
    scope: selected,
    revision,
    claimToken: revision === 0 ? null : ("claim-1" as A1SafeId),
    coordinatorLeaseId: revision === 0 ? null : LEASE,
    coordinatorEpoch: revision === 0 ? null : 1,
    claimedAtMs: revision === 0 ? null : 100,
    lastOperationId: null,
    lastOperationKind: null,
    lastOperationDigest: null,
    updatedAtMs: 100,
  };
}

function fakeRouteState(
  selected: BrokerRouteActorScope,
  actor: IngressRouteActorRecord,
): IngressRouteState {
  return {
    actor: { ...selected, ...actor } as IngressRouteState["actor"],
    runtime: {
      ...selected,
      machineIdentityId: IDENTITY,
      state: "current",
      currentChannelGeneration: 0,
      activeGapCount: 0,
      updatedAtMs: 100,
    },
    generationObservations: [
      {
        ...selected,
        channelGeneration: 0,
        state: "open",
        observedNextFrameIndex: 0,
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
        firstObservedAtMs: 100,
        lastObservedAtMs: 100,
      },
    ],
    fetchCursor: {
      brokerRouteId: selected.brokerRouteId,
      nextGeneration: 0,
      nextFrameIndex: 0,
      revision: 0,
      updatedAtMs: 100,
    },
    semanticCursor: {
      brokerRouteId: selected.brokerRouteId,
      nextGeneration: 0,
      nextFrameIndex: 0,
      contiguousThroughGeneration: null,
      contiguousThroughFrameIndex: null,
      revision: 0,
      updatedAtMs: 100,
    },
    gaps: [],
    positions: [],
    results: [],
    attempts: [],
    candidates: [],
    parts: [],
    observations: [],
    readPageObservations: [],
    readPageFrameEvidence: [],
  };
}

function fakeActorHarness(
  selected: BrokerRouteActorScope,
  page: InternalA1BrokerReadEvidencePageV1 | Error,
  options: Readonly<{
    unknownStage?: "landed" | "absent";
    unknownInbound?: "landed" | "absent";
    quotaStage?: boolean;
    quotaClassify?: boolean;
    dueResult?: boolean;
    inboundStates?: readonly ("assembling" | "awaiting_order")[];
    clockValues?: readonly number[];
    initialGapReason?: IngressRouteState["gaps"][number]["reason"];
  }> = {},
): Readonly<{
  actorOptions: DormantA1IngressRouteActorOptions;
  calls: string[];
  readCounts: {
    fullHistory: number;
    routeHead: number;
    dueResult: number;
    classification: number;
  };
  state: IngressRouteState;
}> {
  const calls: string[] = [];
  const readCounts = { fullHistory: 0, routeHead: 0, dueResult: 0, classification: 0 };
  let actorRecord = fakeActorRecord(selected);
  const routeState = fakeRouteState(selected, actorRecord);
  const artifacts = new Map<ProtectedHandleId, Uint8Array>();
  let artifactSequence = 20;
  let pendingRows: PendingIngressPosition[] = [];
  let stagedUnknownInjected = false;
  let inboundUnknownInjected = false;
  let reconciledInbound: IngressMutationResult | null = null;
  const positionClassifications = new Map<A1SafeId, IngressPositionClassification>();
  let inboundIndex = 0;
  let clockIndex = 0;
  const assertMonotonic = (request: { readonly observedAtMs: number }) => {
    if (request.observedAtMs < actorRecord.updatedAtMs) {
      throw new Error("fake repository rejected a regressing actor timestamp");
    }
  };

  if (options.initialGapReason !== undefined) {
    Object.assign(routeState.runtime, { state: "quarantined", activeGapCount: 1 });
    Object.assign(routeState, {
      gaps: [
        {
          ...selected,
          gapId: `gap-${options.initialGapReason}` as A1SafeId,
          reason: options.initialGapReason,
          channelPositionObservationId: null,
          channelGeneration: null,
          manifestEquivocationId: null,
          transportKeyCollisionId: null,
          stableSemanticResultId: null,
          evidenceRef: `rcph_${base64urlEncode(new Uint8Array(16).fill(88))}` as ProtectedHandleId,
          evidenceDigest: ZERO_DIGEST,
          state: "open",
          openedAtMs: 100,
          resolvedAtMs: null,
          recoveryId: null,
        },
      ],
    });
  }

  if (options.dueResult === true) {
    Object.assign(routeState, {
      results: [
        {
          ...selected,
          stableSemanticResultId: `rrs_${base64urlEncode(new Uint8Array(32).fill(55))}` as A1SafeId,
          sourceEventNamespaceId: `wns_${base64urlEncode(new Uint8Array(32).fill(56))}` as A1SafeId,
          messageId: "expired-message" as A1SafeId,
          recordKind: "user",
          clientMessageId: "expired-client" as A1SafeId,
          expectedParts: 2,
          sourcePayloadSchemaId: null,
          canonicalMessageDigest: null,
          sourceEventFingerprintSchemaId: null,
          sourceEventFingerprint: null,
          firstIngressGeneration: 0,
          firstIngressFrameIndex: 0,
          lastObservedIngressGeneration: 0,
          lastObservedIngressFrameIndex: 0,
          assemblyDeadlineMs: 99,
          state: "assembling",
          collisionAtMs: null,
          terminalAtMs: null,
        },
      ],
    });
  }

  const nextActor = (claimToken: A1SafeId | null = actorRecord.claimToken) => {
    actorRecord = {
      ...actorRecord,
      revision: actorRecord.revision + 1,
      claimToken,
      coordinatorLeaseId: claimToken === null ? null : LEASE,
      coordinatorEpoch: claimToken === null ? null : 1,
      claimedAtMs: claimToken === null ? null : 100,
    };
    Object.assign(routeState, { actor: { ...selected, ...actorRecord } });
    return actorRecord;
  };
  const mutation = (label: string): IngressMutationResult => {
    calls.push(label);
    return { actor: nextActor(), replayed: false };
  };
  const ingress = {
    readRouteState: () => {
      readCounts.fullHistory++;
      return routeState;
    },
    readRouteHead: () => {
      readCounts.routeHead++;
      const currentGeneration = routeState.generationObservations.find(
        (generation) =>
          generation.channelGeneration === routeState.runtime.currentChannelGeneration,
      );
      if (currentGeneration === undefined) return null;
      return {
        routeStoreInstanceId: parseBrokerRouteStoreInstanceId(
          `rbsi_${base64urlEncode(new Uint8Array(16).fill(10))}`,
        ),
        actor: routeState.actor,
        runtime: routeState.runtime,
        currentGeneration,
        fetchCursor: routeState.fetchCursor,
        semanticCursor: routeState.semanticCursor,
        hasOpenGaps: routeState.gaps.some((gap) => gap.state === "open"),
        hasOpenStorageQuotaGap: routeState.gaps.some(
          (gap) => gap.state === "open" && gap.reason === "storage_quota",
        ),
      };
    },
    readNextDueAssemblingResult: (_routeId, dueAtOrBeforeMs) => {
      readCounts.dueResult++;
      const due = routeState.results
        .filter(
          (result) => result.state === "assembling" && result.assemblyDeadlineMs <= dueAtOrBeforeMs,
        )
        .sort(
          (left, right) =>
            left.assemblyDeadlineMs - right.assemblyDeadlineMs ||
            left.stableSemanticResultId.localeCompare(right.stableSemanticResultId),
        )[0];
      return due === undefined
        ? null
        : {
            stableSemanticResultId: due.stableSemanticResultId,
            assemblyDeadlineMs: due.assemblyDeadlineMs,
          };
    },
    readPositionClassification: (_routeId, ingressObservationId) => {
      readCounts.classification++;
      return positionClassifications.get(ingressObservationId) ?? null;
    },
    readPendingPositions: () => [...pendingRows],
    claimRouteActor: (request) => {
      assertMonotonic(request);
      calls.push("claim");
      actorRecord = {
        ...nextActor(request.claimToken),
        claimToken: request.claimToken,
      };
      return { actor: actorRecord, replayed: false };
    },
    reconcileRouteActorClaim: () => null,
    releaseRouteActor: () => mutation("release"),
    reconcileRouteActorRelease: () => null,
    latchOuterPageGap: () => mutation("outer-gap"),
    reconcileOuterPageGap: () => null,
    latchStorageQuotaGap: () => mutation("storage-quota"),
    reconcileStorageQuotaGap: () => null,
    stageReadPage: (request) => {
      assertMonotonic(request);
      calls.push("stage");
      if (options.quotaStage === true) throw new IngressRepositoryQuotaError();
      const land = () => {
        pendingRows = request.frames.map((frame) => ({
          channelPositionObservationId: frame.channelPositionObservationId,
          cursor: frame.cursor,
          receivedFrameRef: frame.receivedFrameRef,
          receivedFrameDigest: frame.receivedFrameDigest,
          receivedFrameByteLength: frame.receivedFrameByteLength,
          claimedDeliveryAttemptId: frame.claimedDeliveryAttemptId,
          claimedPart: frame.claimedPart,
          claimedTransportFrameDigest: frame.claimedTransportFrameDigest,
        }));
        Object.assign(routeState.fetchCursor, {
          ...routeState.fetchCursor,
          nextGeneration: request.nextPosition.channelGeneration,
          nextFrameIndex: request.nextPosition.nextFrameIndex,
        });
        nextActor();
      };
      if (!stagedUnknownInjected && options.unknownStage !== undefined) {
        stagedUnknownInjected = true;
        if (options.unknownStage === "landed") land();
        throw new HostStateCommitOutcomeUnknownError("injected stage outcome");
      }
      land();
      return { actor: actorRecord, replayed: false };
    },
    reconcileStageReadPage: () =>
      options.unknownStage === "landed" ? { actor: actorRecord, replayed: true } : null,
    classifyInvalidPosition: () => {
      calls.push("invalid");
      pendingRows = pendingRows.slice(1);
      return { actor: nextActor(), replayed: false };
    },
    classifyUnknownOutboundPosition: () => {
      calls.push("unknown-outbound");
      pendingRows = pendingRows.slice(1);
      return { actor: nextActor(), replayed: false };
    },
    classifyInboundPart: (request) => {
      assertMonotonic(request);
      calls.push("inbound");
      if (options.quotaClassify === true) throw new IngressRepositoryQuotaError();
      const land = () => {
        pendingRows = pendingRows.slice(1);
        const resultState = options.inboundStates?.[inboundIndex++] ?? "awaiting_order";
        const classification = {
          candidateState: resultState === "assembling" ? "assembling" : "complete",
          resultState,
          stableSemanticResultId: request.stableSemanticResultId,
          sourcePayloadSchemaId: "remote-claw/a1-ingress-user/v1",
          canonicalMessageDigest: ZERO_DIGEST,
          sourceEventFingerprint: ZERO_DIGEST,
        } as const;
        positionClassifications.set(request.ingressObservationId, classification);
        return {
          actor: nextActor(),
          replayed: false,
          ...classification,
        };
      };
      if (!inboundUnknownInjected && options.unknownInbound !== undefined) {
        inboundUnknownInjected = true;
        if (options.unknownInbound === "landed") {
          const landed = land();
          reconciledInbound = { actor: landed.actor, replayed: true };
        }
        throw new HostStateCommitOutcomeUnknownError("injected classification outcome");
      }
      return land();
    },
    reconcilePositionClassification: () => reconciledInbound,
    expireResult: (request) => {
      const result = routeState.results.find(
        (entry) => entry.stableSemanticResultId === request.stableSemanticResultId,
      );
      if (result !== undefined) Object.assign(result, { state: "quarantined_incomplete" });
      return mutation("expire");
    },
    reconcileResultExpiry: () => null,
    recoverGap: () => mutation("recover"),
    reconcileGapRecovery: () => null,
    recomputeSemanticCursor: (request) => {
      assertMonotonic(request);
      return mutation("recompute");
    },
    reconcileSemanticCursorRecompute: () => null,
  } satisfies IngressRepositoryOperations;

  const transaction = <T>(operation: (transaction: DormantIngressTransaction) => T): T =>
    operation({
      ingress,
      putArtifact(request) {
        const protectedHandleId =
          `rcph_${base64urlEncode(new Uint8Array(16).fill(artifactSequence++))}` as ProtectedHandleId;
        artifacts.set(protectedHandleId, request.artifactBytes.copyBytes());
        return { artifactRef: { protectedHandleId, kind: "artifact" } };
      },
      readVerifiedArtifact(request) {
        const artifactBytes = artifacts.get(request.artifactRef.protectedHandleId);
        if (artifactBytes === undefined) throw new Error("missing fake artifact");
        return { artifactBytes: ProtectedByteSnapshot.from(artifactBytes) };
      },
    });
  const database: DormantIngressDatabase = {
    machineIdentityId: IDENTITY,
    ingress,
    transaction,
    close: vi.fn(),
  };
  let operationSequence = 0;
  return {
    actorOptions: {
      database,
      reopenDatabase: () => database,
      scope: selected,
      fence: {
        collaborationServerId: SERVER,
        coordinatorLeaseId: LEASE,
        coordinatorEpoch: 1,
      },
      actorClaimToken: "claim-1" as A1SafeId,
      evidenceReader: {
        read: async () => {
          if (page instanceof Error) throw page;
          return page;
        },
      },
      resolvePlaneKey: async () => KEY,
      allocateOperationId: () => `operation-${++operationSequence}` as A1SafeId,
      nowMs: () =>
        options.clockValues?.[
          Math.min(clockIndex++, Math.max(0, options.clockValues.length - 1))
        ] ?? 100,
    },
    calls,
    readCounts,
    state: routeState,
  };
}

describe("dormant A1.7a ingress actor helpers", () => {
  it("constructs exact chat/server-control/scope-bus routes", async () => {
    const chat = a1IngressRouteFromScope(IDENTITY, scope());
    expect(await deriveA1BrokerRouteId(chat)).toBe(scope().brokerRouteId);
    expect(
      a1IngressRouteFromScope(
        IDENTITY,
        scope({ routeKind: "server_control", logicalChatId: null }),
      ),
    ).toMatchObject({ routeKind: "server_control", logicalChatId: null });
    expect(
      a1IngressRouteFromScope(IDENTITY, scope({ routeKind: "scope_bus", logicalChatId: null })),
    ).toMatchObject({ routeKind: "scope_bus", logicalChatId: null });
  });

  it("snapshots raw frames before parsing and asks for the exact durable fetch cursor", async () => {
    const selected = scope();
    const value = await canonicalFrame();
    const page: InternalA1BrokerReadEvidencePageV1 = {
      schemaVersion: 1,
      brokerRouteId: selected.brokerRouteId,
      routeStoreInstanceId: `rbsi_${base64urlEncode(new Uint8Array(16).fill(10))}`,
      requestedPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      generation: {
        schemaVersion: 1,
        brokerRouteId: selected.brokerRouteId,
        channelGeneration: 0,
        state: "open",
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
      },
      observedNextFrameIndex: 1,
      frames: [
        {
          cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
          deliveryAttemptId: ATTEMPT,
          part: 0,
          transportFrameDigest: value.digest,
          rawFrame: value.raw,
        },
      ],
      nextPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 1 },
      atLiveTail: true,
    };
    const prepared = await prepareIngressEvidencePage(selected.brokerRouteId, page);
    expect(new TextDecoder().decode(prepared.frames[0]?.rawFrameBytes)).toBe(value.raw);
    expect(prepared.frames[0]?.rawFrameDigest).toHaveLength(43);
    expect(prepared.pageEvidenceDigest).toHaveLength(43);

    const reader: InternalA1BrokerEvidenceReader = { read: vi.fn(async () => page) };
    await readIngressEvidencePage(reader, page.requestedPosition);
    expect(reader.read).toHaveBeenCalledWith({ position: page.requestedPosition, maxFrames: 64 });
  });

  it("route-matches and broker-claim-matches before resolving any key", async () => {
    const selected = scope();
    const value = await canonicalFrame();
    const resolvePlaneKey = vi.fn(async () => KEY);
    const transplanted = await inspectPendingIngressFrame({
      machineIdentityId: IDENTITY,
      scope: scope({
        logicalChatId: `rcl_${base64urlEncode(new Uint8Array(16).fill(99))}` as LogicalChatId,
      }),
      pending: pending(selected.brokerRouteId),
      rawFrameBytes: new TextEncoder().encode(value.raw),
      resolvePlaneKey,
      claimedDeliveryAttemptId: ATTEMPT,
      claimedPart: 0,
      claimedTransportFrameDigest: value.digest,
    });
    expect(transplanted).toMatchObject({
      classification: "invalid",
      validationFailureCode: "route_mismatch",
      parsed: {
        channelPositionObservationId: pending(selected.brokerRouteId).channelPositionObservationId,
        normalizedTransportFrameDigest: value.digest,
      },
    });
    expect(resolvePlaneKey).not.toHaveBeenCalled();

    const changedClaim = await inspectPendingIngressFrame({
      machineIdentityId: IDENTITY,
      scope: selected,
      pending: pending(selected.brokerRouteId),
      rawFrameBytes: new TextEncoder().encode(value.raw),
      resolvePlaneKey,
      claimedDeliveryAttemptId: ATTEMPT,
      claimedPart: 0,
      claimedTransportFrameDigest: ZERO_DIGEST,
    });
    expect(changedClaim).toMatchObject({
      classification: "invalid",
      validationFailureCode: "outer_inner_claim_mismatch",
    });
    expect(resolvePlaneKey).not.toHaveBeenCalled();
  });

  it("opens selected inbound payloads and terminally classifies AEAD/payload failures", async () => {
    const selected = scope();
    const value = await canonicalFrame();
    const common = {
      machineIdentityId: IDENTITY,
      scope: selected,
      pending: pending(selected.brokerRouteId),
      rawFrameBytes: new TextEncoder().encode(value.raw),
      claimedDeliveryAttemptId: ATTEMPT,
      claimedPart: 0,
      claimedTransportFrameDigest: value.digest,
    };
    const opened = await inspectPendingIngressFrame({
      ...common,
      resolvePlaneKey: async () => KEY,
    });
    expect(opened).toMatchObject({ classification: "inbound_ingress" });
    if (opened.classification === "inbound_ingress") {
      expect(new TextDecoder().decode(opened.plaintextPart)).toBe('{"v":1,"text":"hello"}');
      expect(opened.stableSemanticResultId).toMatch(/^rrs_/);
      expect(opened.ingressObservationId).toMatch(/^rio_/);
    }
    expect(
      await inspectPendingIngressFrame({
        ...common,
        resolvePlaneKey: async () => new Uint8Array(32).fill(44),
      }),
    ).toMatchObject({
      classification: "invalid",
      validationFailureCode: "aead_authentication_failed",
    });
    await expect(
      inspectPendingIngressFrame({
        ...common,
        resolvePlaneKey: async () => {
          throw new Error("key store temporarily unavailable");
        },
      }),
    ).rejects.toThrow(/temporarily unavailable/);

    const providerOwnedKey = new Uint8Array(KEY);
    const seenPrivateKeys: Uint8Array[] = [];
    const openedTransient = new TextEncoder().encode('{"v":1,"text":"hello"}');
    const scrubbed = await inspectPendingIngressFrame({
      ...common,
      resolvePlaneKey: async () => providerOwnedKey,
      openPart: async (privateKey, _frame) => {
        seenPrivateKeys.push(privateKey);
        return openedTransient;
      },
    });
    expect(providerOwnedKey).toEqual(KEY);
    expect(seenPrivateKeys[0]).not.toBe(providerOwnedKey);
    expect(seenPrivateKeys[0]).toEqual(new Uint8Array(32));
    expect(openedTransient).toEqual(new Uint8Array(openedTransient.byteLength));
    expect(scrubbed.classification).toBe("inbound_ingress");
    if (scrubbed.classification === "inbound_ingress") {
      expect(new TextDecoder().decode(scrubbed.plaintextPart)).toBe('{"v":1,"text":"hello"}');
    }

    const malformed = await canonicalFrame(new TextEncoder().encode('{"v":1,"text":"x"} '));
    expect(
      await inspectPendingIngressFrame({
        ...common,
        rawFrameBytes: new TextEncoder().encode(malformed.raw),
        claimedTransportFrameDigest: malformed.digest,
        resolvePlaneKey: async () => KEY,
      }),
    ).toMatchObject({
      classification: "invalid",
      validationFailureCode: "invalid_selected_payload",
    });
  });

  it("scrubs retained inbound plaintext when operation allocation fails after opening", async () => {
    const selected = scope();
    const value = await canonicalFrame();
    const page = evidencePage(selected, [
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
        deliveryAttemptId: ATTEMPT,
        part: 0,
        transportFrameDigest: value.digest,
        rawFrame: value.raw,
      },
    ]);
    const harness = fakeActorHarness(selected, page);
    const expectedPlaintext = new TextEncoder().encode('{"v":1,"text":"hello"}');
    const openedTransient = expectedPlaintext.slice();
    let operationCount = 0;
    let allocationFailed = false;
    const scrubbedAfterFailure: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    const fillSpy = vi.spyOn(Uint8Array.prototype, "fill").mockImplementation(function (
      this: Uint8Array,
      value,
      start?,
      end?,
    ) {
      const heldPlaintext =
        allocationFailed &&
        this.byteLength === expectedPlaintext.byteLength &&
        this.every((byte, index) => byte === expectedPlaintext[index]);
      const result =
        start === undefined
          ? originalFill.call(this, value)
          : end === undefined
            ? originalFill.call(this, value, start)
            : originalFill.call(this, value, start, end);
      if (heldPlaintext) scrubbedAfterFailure.push(this);
      return result;
    });
    try {
      const actor = createDormantA1IngressRouteActor({
        ...harness.actorOptions,
        openPart: async () => openedTransient,
        allocateOperationId: () => {
          operationCount++;
          if (operationCount === 3) {
            allocationFailed = true;
            throw new Error("operation allocator failed after plaintext open");
          }
          return `operation-${operationCount}` as A1SafeId;
        },
      });
      await expect(actor.runCycle()).rejects.toThrow(/allocator failed/);
    } finally {
      fillSpy.mockRestore();
    }
    expect(openedTransient).toEqual(new Uint8Array(openedTransient.byteLength));
    expect(scrubbedAfterFailure).toHaveLength(1);
    expect(scrubbedAfterFailure[0]).toEqual(
      new Uint8Array(scrubbedAfterFailure[0]?.byteLength ?? 0),
    );
  });

  it("rejects unsupported recognized inbound kinds and keeps outbound explicit", async () => {
    const selected = scope();
    const unsupported = await canonicalFrame(new Uint8Array(), {
      recordKind: "attachment",
      clientMsgId: "attachment-1",
    });
    expect(
      await inspectPendingIngressFrame({
        machineIdentityId: IDENTITY,
        scope: selected,
        pending: pending(selected.brokerRouteId),
        rawFrameBytes: new TextEncoder().encode(unsupported.raw),
        resolvePlaneKey: vi.fn(),
        claimedDeliveryAttemptId: ATTEMPT,
        claimedPart: 0,
        claimedTransportFrameDigest: unsupported.digest,
      }),
    ).toMatchObject({
      classification: "invalid",
      validationFailureCode: "unsupported_record_kind",
    });

    const outboundHeader = header({
      dir: "out",
      recordKind: "assistant",
      seq: 1,
      clientMsgId: null,
      serverKeyGeneration: 1,
      hostSignerIdentityKeyId: "host-signer-1",
      hostScopeCertificateId: "host-scope-cert-1",
      hostSignatureSequence: 1,
    });
    const outboundSealed = await sealA1FramePartWith(
      KEY,
      outboundHeader,
      new Uint8Array(),
      SALT,
      NONCE,
    );
    const outboundRaw = encodeA1EncryptedFrameV2({
      ...outboundSealed,
      hostSignature: new Uint8Array(64).fill(1),
    });
    const outboundDigest = (await parseA1BrokerCanonicalFrameV1(outboundRaw))
      .transportFrameDigest as A1Digest;
    const resolveOutboundKey = vi.fn();
    expect(
      await inspectPendingIngressFrame({
        machineIdentityId: IDENTITY,
        scope: selected,
        pending: pending(selected.brokerRouteId),
        rawFrameBytes: new TextEncoder().encode(outboundRaw),
        resolvePlaneKey: resolveOutboundKey,
        claimedDeliveryAttemptId: ATTEMPT,
        claimedPart: 0,
        claimedTransportFrameDigest: outboundDigest,
      }),
    ).toMatchObject({ classification: "unknown_outbound" });
    expect(resolveOutboundKey).not.toHaveBeenCalled();
  });

  it("runs routes concurrently up to eight while preserving result order", async () => {
    let active = 0;
    let peak = 0;
    const resolvers: (() => void)[] = [];
    const tasks = Array.from({ length: 12 }, (_, index) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active--;
      return index;
    });
    const completion = runBoundedIngressRouteScheduler(tasks, 3);
    await vi.waitFor(() => expect(active).toBe(3));
    while (resolvers.length > 0) {
      resolvers.splice(0).forEach((resolve) => {
        resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await completion).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(peak).toBe(3);
    await expect(runBoundedIngressRouteScheduler([], 9)).rejects.toThrow(/1 through 8/);
  });

  it("composes claim, whole-page stage, verified decrypt/classify, cursor recompute, and release", async () => {
    const selected = scope();
    const value = await canonicalFrame();
    const page = evidencePage(selected, [
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
        deliveryAttemptId: ATTEMPT,
        part: 0,
        transportFrameDigest: value.digest,
        rawFrame: value.raw,
      },
    ]);
    const harness = fakeActorHarness(selected, page);
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toEqual({
      fetched: true,
      stagedFrames: 1,
      processedPositions: 1,
      awaitingOrder: 1,
      atLiveTail: true,
    });
    expect(harness.calls).toEqual(["claim", "stage", "inbound", "recompute"]);
    expect(harness.readCounts).toMatchObject({ fullHistory: 0, classification: 0 });
    expect(harness.readCounts.routeHead).toBeGreaterThanOrEqual(3);
    actor.release();
    expect(harness.calls).toEqual(["claim", "stage", "inbound", "recompute", "release"]);
  });

  it.each([
    "landed",
    "absent",
  ] as const)("reconciles an unknown page-stage COMMIT that is %s before processing", async (outcome) => {
    const selected = scope();
    const value = await canonicalFrame();
    const page = evidencePage(selected, [
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
        deliveryAttemptId: ATTEMPT,
        part: 0,
        transportFrameDigest: value.digest,
        rawFrame: value.raw,
      },
    ]);
    const harness = fakeActorHarness(selected, page, { unknownStage: outcome });
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({
      stagedFrames: 1,
      processedPositions: 1,
      awaitingOrder: 1,
    });
    expect(harness.calls.filter((call) => call === "stage")).toHaveLength(
      outcome === "landed" ? 1 : 2,
    );
    expect(harness.calls).toContain("inbound");
    expect(harness.readCounts.fullHistory).toBe(0);
  });

  it.each([
    "landed",
    "absent",
  ] as const)("reconciles an unknown inbound-classification COMMIT that is %s with bounded reads", async (outcome) => {
    const selected = scope();
    const value = await canonicalFrame();
    const page = evidencePage(selected, [
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
        deliveryAttemptId: ATTEMPT,
        part: 0,
        transportFrameDigest: value.digest,
        rawFrame: value.raw,
      },
    ]);
    const harness = fakeActorHarness(selected, page, { unknownInbound: outcome });
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({
      stagedFrames: 1,
      processedPositions: 1,
      awaitingOrder: 1,
    });
    expect(harness.calls.filter((call) => call === "inbound")).toHaveLength(
      outcome === "landed" ? 1 : 2,
    );
    expect(harness.readCounts).toMatchObject({
      fullHistory: 0,
      classification: outcome === "landed" ? 1 : 0,
    });
  });

  it("latches authenticated outer-page protocol failure without staging or cursor advance", async () => {
    const selected = scope();
    const harness = fakeActorHarness(selected, new A1BrokerProtocolError("malformed read page"));
    const before = harness.state.fetchCursor.nextFrameIndex;
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toEqual({
      fetched: false,
      stagedFrames: 0,
      processedPositions: 0,
      awaitingOrder: 0,
      atLiveTail: false,
    });
    expect(harness.calls).toEqual(["claim", "outer-gap", "recompute"]);
    expect(harness.state.fetchCursor.nextFrameIndex).toBe(before);
  });

  it("rolls a quota-rejected page into a bounded storage gap without advancing fetch", async () => {
    const selected = scope();
    const value = await canonicalFrame();
    const page = evidencePage(selected, [
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
        deliveryAttemptId: ATTEMPT,
        part: 0,
        transportFrameDigest: value.digest,
        rawFrame: value.raw,
      },
    ]);
    const harness = fakeActorHarness(selected, page, { quotaStage: true });
    const before = harness.state.fetchCursor.nextFrameIndex;
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({ fetched: false, stagedFrames: 0 });
    expect(harness.calls).toEqual(["claim", "stage", "storage-quota", "recompute"]);
    expect(harness.state.fetchCursor.nextFrameIndex).toBe(before);
  });

  it("latches a bounded storage gap when plaintext classification exceeds retained quota", async () => {
    const selected = scope();
    const value = await canonicalFrame();
    const page = evidencePage(selected, [
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
        deliveryAttemptId: ATTEMPT,
        part: 0,
        transportFrameDigest: value.digest,
        rawFrame: value.raw,
      },
    ]);
    const harness = fakeActorHarness(selected, page, { quotaClassify: true });
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({
      fetched: true,
      stagedFrames: 1,
      processedPositions: 0,
      awaitingOrder: 0,
    });
    expect(harness.calls).toEqual(["claim", "stage", "inbound", "storage-quota", "recompute"]);
  });

  it("does not reprocess pending plaintext after a retained storage-quota gap", async () => {
    const selected = scope();
    const harness = fakeActorHarness(selected, evidencePage(selected, []), {
      initialGapReason: "storage_quota",
    });
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({
      fetched: false,
      processedPositions: 0,
    });
    await expect(actor.runCycle()).resolves.toMatchObject({
      fetched: false,
      processedPositions: 0,
    });
    expect(harness.calls).toEqual(["claim", "recompute", "claim", "recompute"]);
    expect(harness.calls).not.toContain("storage-quota");
  });

  it("leaves an outcome-unknown read retriable without staging or latching a gap", async () => {
    const selected = scope();
    const harness = fakeActorHarness(selected, new A1BrokerOutcomeUnknownError());
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({
      fetched: false,
      stagedFrames: 0,
      processedPositions: 0,
    });
    expect(harness.calls).toEqual(["claim", "recompute"]);
    expect(harness.state.fetchCursor.nextFrameIndex).toBe(0);
  });

  it("quarantines a fabricated page cursor before staging any supplied bytes", async () => {
    const selected = scope();
    const page = evidencePage(selected, []);
    const fabricated = {
      ...page,
      requestedPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 7 },
    } as InternalA1BrokerReadEvidencePageV1;
    const harness = fakeActorHarness(selected, fabricated);
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({ fetched: false, stagedFrames: 0 });
    expect(harness.calls).toEqual(["claim", "outer-gap", "recompute"]);
    expect(harness.state.fetchCursor.nextFrameIndex).toBe(0);
  });

  it("lets fetch/classification run ahead while an earlier multipart result blocks semantic order", async () => {
    const selected = scope();
    const partialA = await canonicalFrame(new TextEncoder().encode('{"v":1,"te'), {
      msgId: "source.a",
      deliveryAttemptId: `rda_${base64urlEncode(new Uint8Array(16).fill(61))}`,
      clientMsgId: "client.a",
      part: 0,
      parts: 2,
    });
    const completeB = await canonicalFrame(new TextEncoder().encode('{"v":1,"text":"b"}'), {
      msgId: "source.b",
      deliveryAttemptId: `rda_${base64urlEncode(new Uint8Array(16).fill(62))}`,
      clientMsgId: "client.b",
    });
    const page = evidencePage(selected, [
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
        deliveryAttemptId: partialA.frame.deliveryAttemptId,
        part: 0,
        transportFrameDigest: partialA.digest,
        rawFrame: partialA.raw,
      },
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 1 },
        deliveryAttemptId: completeB.frame.deliveryAttemptId,
        part: 0,
        transportFrameDigest: completeB.digest,
        rawFrame: completeB.raw,
      },
    ]);
    const harness = fakeActorHarness(selected, page, {
      inboundStates: ["assembling", "awaiting_order"],
    });
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({
      stagedFrames: 2,
      processedPositions: 2,
      awaitingOrder: 1,
    });
    expect(harness.state.fetchCursor.nextFrameIndex).toBe(2);
    expect(harness.state.semanticCursor.nextFrameIndex).toBe(0);
    expect(harness.calls).toEqual(["claim", "stage", "inbound", "inbound", "recompute"]);
  });

  it("expires due assembling results at their stored deadline without extending it", async () => {
    const selected = scope();
    const harness = fakeActorHarness(selected, evidencePage(selected, []), { dueResult: true });
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await actor.runCycle();
    expect(harness.calls).toEqual(["claim", "expire", "recompute"]);
    expect(harness.state.results[0]).toMatchObject({
      assemblyDeadlineMs: 99,
      state: "quarantined_incomplete",
    });
    expect(harness.readCounts.fullHistory).toBe(0);
    expect(harness.readCounts.dueResult).toBeGreaterThanOrEqual(2);
  });

  it("clamps a backward wall-clock step to the retained actor timestamp", async () => {
    const selected = scope();
    const harness = fakeActorHarness(selected, evidencePage(selected, []), {
      clockValues: [100, 99, 98, 97],
    });
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({ fetched: true, stagedFrames: 0 });
    expect(harness.calls).toEqual(["claim", "recompute"]);
  });

  it("does not retain a fresh artifact for an unchanged empty open live tail", async () => {
    const selected = scope();
    const harness = fakeActorHarness(selected, evidencePage(selected, []));
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({
      fetched: true,
      stagedFrames: 0,
      atLiveTail: true,
    });
    await expect(actor.runCycle()).resolves.toMatchObject({
      fetched: true,
      stagedFrames: 0,
      atLiveTail: true,
    });
    expect(harness.calls.filter((call) => call === "stage")).toHaveLength(0);
    expect(harness.calls.filter((call) => call === "recompute")).toHaveLength(2);
    expect(harness.state.readPageObservations).toHaveLength(0);
  });

  it("does not let the empty-tail fast path hide a route-store fork", async () => {
    const selected = scope();
    const page = evidencePage(selected, []);
    const harness = fakeActorHarness(selected, {
      ...page,
      routeStoreInstanceId: parseBrokerRouteStoreInstanceId(
        `rbsi_${base64urlEncode(new Uint8Array(16).fill(11))}`,
      ),
    });
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({
      fetched: false,
      stagedFrames: 0,
      atLiveTail: false,
    });
    expect(harness.calls).toEqual(["claim", "outer-gap", "recompute"]);
    expect(harness.state.readPageObservations).toHaveLength(0);
  });

  it("does not suppress a sealed empty-generation transition", async () => {
    const selected = scope();
    const base = evidencePage(selected, []);
    const manifestDigest = await a1BrokerGenerationManifestDigest({
      brokerRouteId: selected.brokerRouteId,
      channelGeneration: 0,
      frameCount: 0,
      nextGeneration: 1,
      state: "sealed",
    });
    const page: InternalA1BrokerReadEvidencePageV1 = {
      ...base,
      generation: {
        ...base.generation,
        state: "sealed",
        frameCount: 0,
        nextGeneration: 1,
        manifestDigest,
      },
      nextPosition: { version: 1, channelGeneration: 1, nextFrameIndex: 0 },
      atLiveTail: false,
    };
    const harness = fakeActorHarness(selected, page);
    const actor = createDormantA1IngressRouteActor(harness.actorOptions);
    await expect(actor.runCycle()).resolves.toMatchObject({ fetched: true, stagedFrames: 0 });
    expect(harness.calls).toContain("stage");
  });
});

void (null as A1BrokerRoute | null);
