import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import { nativeRuntimeId } from "../state/digests.js";
import {
  type A1CanonicalId,
  type A1CanonicalIdKind,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseWardenLaunchNonce,
} from "../state/ids.js";
import type { RuntimeOwnerOperationEvidence } from "../state/runtime-repository.js";
import { HostStateCommitOutcomeUnknownError, openHostStateDatabase } from "../state/sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "../state/test-environment.js";
import { createRuntimeOwnerKeyCustodySigner } from "./key-custody.js";
import type { RuntimeOwnerRpcJsonValue } from "./protocol.js";
import {
  createNativeRegistrationOrchestrator,
  type NativeRegistrationAdapter,
  type NativeRegistrationDatabaseAccess,
  type NativeRegistrationReattachMeasurement,
  type ParsedNativeRegistrationOpenMeasurement,
} from "./registration-service.js";
import type { RuntimeOwnerOperationContext } from "./service.js";

const MACHINE_IDENTITY_ID = "d4".repeat(16);
const roots: string[] = [];
const describeLinux = describe.runIf(
  process.platform === "linux" &&
    typeof process.getuid === "function" &&
    HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
);

function canonicalId<K extends A1CanonicalIdKind>(kind: K, fill: number): A1CanonicalId<K> {
  const prefix = {
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
  } as const;
  const bytes =
    kind === "nativeRuntime" ||
    kind === "projectTargetSelectorMapping" ||
    kind === "nativeDeliveryAttempt"
      ? 32
      : 16;
  return parseA1CanonicalId(
    kind,
    `${prefix[kind]}${base64urlEncode(new Uint8Array(bytes).fill(fill))}`,
  );
}

function digest(fill: number) {
  return parseA1Digest(base64urlEncode(new Uint8Array(32).fill(fill)));
}

function operation(label: string, fill: number): RuntimeOwnerOperationEvidence {
  return {
    operationId: parseA1SafeId(`${label}-${fill}`),
    operationSchemaId: `remote-claw/test/${label}/v1`,
    operationDigest: digest(fill),
  };
}

function temporaryState() {
  const root = mkdtempSync(join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a14-service-"));
  roots.push(root);
  return {
    xdgStateHome: join(root, "state"),
    homeDirectory: join(root, "home"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function createRegistrationHarness(fill: number) {
  const environment = temporaryState();
  const database = openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: environment,
  });
  const server = database.records.ensureDefaultCollaborationServer().server;
  const coordinator = database.records.acquireCoordinatorLease({
    collaborationServerId: server.collaborationServerId,
    candidateLeaseId: canonicalId("coordinatorLease", fill),
    ownerInstanceId: parseA1SafeId(`harness-coordinator-${fill}`),
    expectedCurrentLeaseId: null,
    expectedCoordinatorEpoch: 0,
    leaseDurationMs: 60_000,
  });
  const owner = database.runtimeOwner.acquireServiceLease({
    candidateLeaseId: parseA1SafeId(`harness-owner-lease-${fill}`),
    ownerInstanceId: parseA1SafeId(`harness-owner-instance-${fill}`),
    ownerProcessStartIdentitySchemaId: "remote-claw/linux-process-start-identity/v1",
    ownerProcessStartIdentityRef: parseA1SafeId(`harness-owner-process-${fill}`),
    ownerProcessStartIdentityDigest: digest(fill + 1),
    expectedCurrentLeaseId: null,
    expectedRuntimeOwnerServiceEpoch: 0,
    leaseDurationMs: 60_000,
    operation: operation(`harness-owner-acquire-${fill}`, fill + 2),
  }).lease;
  const wardenLaunchNonce = parseWardenLaunchNonce(
    base64urlEncode(new Uint8Array(32).fill(fill + 3)),
  );
  const startIdentityDigest = digest(fill + 4);
  const runtimeId = await nativeRuntimeId({
    wardenLaunchNonce,
    startIdentitySchemaId: "remote-claw/test/native-start/v1",
    startIdentityDigest,
  });
  const descriptor = { product: "codex", access: "app-server" } as const;
  const state: {
    open: ParsedNativeRegistrationOpenMeasurement;
    reattach: NativeRegistrationReattachMeasurement;
  } = {
    open: {
      registrationAttemptId: canonicalId("registrationAttempt", fill + 5),
      descriptor,
      initialPhase: "starting",
      expectedNativeRef: null,
      selection: {
        kind: "first_bootstrap",
        workspaceSelectorId: `workspace-${fill}`,
        terminalProjectRef: `terminal-project-${fill}`,
        mappingEvidenceRef: `mapping-evidence-${fill}`,
      },
      metadata: {
        schemaId: "remote-claw/test/provider-metadata/v1",
        bytes: base64urlEncode(Uint8Array.of(fill, 1)),
      },
      runtime: {
        runtimeId,
        nativeIncarnation: 1,
        wardenLaunchNonce,
        startIdentitySchemaId: "remote-claw/test/native-start/v1",
        startIdentityRef: `native-start-ref-${fill}`,
        startIdentityDigest,
        runtimeOwnerAssignmentId: `runtime-assignment-${fill}`,
        expectedRuntimeOwnerAssignmentId: null,
        reattachmentEvidenceSchemaId: null,
        reattachmentEvidenceRef: null,
        reattachmentEvidenceDigest: null,
        signingKeyRef: canonicalId("protectedHandle", fill + 6),
        localTrustEvidenceRef: `local-trust-ref-${fill}`,
        localTrustEvidenceDigest: digest(fill + 7),
      },
      binding: {
        nativeBindingIncarnationId: `binding-incarnation-${fill}`,
        attachmentId: `attachment-${fill}`,
        attachmentKind: "app-server",
        transportId: `transport-${fill}`,
        attachmentGeneration: 1,
        attachmentLeaseId: `attachment-lease-${fill}`,
        transportEpoch: 1,
        resourceOwnership: "shared_runtime",
        disconnectPolicy: "detach",
      },
      nativeConversationLeaseId: canonicalId("nativeConversationLease", fill + 8),
    },
    reattach: {
      nativeConversationLeaseId: canonicalId("nativeConversationLease", fill + 9),
      successorAttachmentLeaseId: null,
      successorBinding: null,
      expectedRuntimeOwnerAssignmentId: null,
      runtimeOwnerAssignmentId: null,
      reattachmentEvidenceSchemaId: null,
      reattachmentEvidenceRef: null,
      reattachmentEvidenceDigest: null,
    },
  };
  const adapter: NativeRegistrationAdapter = {
    measureOpen: () => state.open,
    measureBinding: () => ({
      nativeRef: {
        descriptor,
        runtimeId,
        conversationId: `semantic-conversation-${fill}`,
        incarnation: 1,
      },
      localTransitionId: `local-transition-${fill}`,
      localNativeConversationId: `local-conversation-${fill}`,
      parentLocalNativeConversationId: null,
    }),
    measurePublication: () => ({
      metadataSchemaId: "remote-claw/test/provider-metadata/v1",
      metadataBytes: Uint8Array.of(fill, 1),
      capabilities: {
        version: 1,
        mutationAdmission: "structured",
        history: "complete",
        deliveryEvidence: "structured_receipt",
        liveReattach: true,
      },
    }),
    measureReattach: () => state.reattach,
  };
  const faults = {
    unknownPrepareAfterCommit: false,
    unknownPrepareBeforeCommit: false,
    unknownFinalizeAfterCommit: false,
    reopenCount: 0,
  };
  const access: NativeRegistrationDatabaseAccess = {
    use: (callback) => {
      if (
        !faults.unknownPrepareAfterCommit &&
        !faults.unknownPrepareBeforeCommit &&
        !faults.unknownFinalizeAfterCommit
      ) {
        return callback(database);
      }
      const terminalRoot: typeof database.terminalRoot = {
        prepare: (request) => {
          if (faults.unknownPrepareBeforeCommit) {
            faults.unknownPrepareBeforeCommit = false;
            throw new HostStateCommitOutcomeUnknownError(
              "injected absent terminal-root preparation",
            );
          }
          const result = database.terminalRoot.prepare(request);
          if (faults.unknownPrepareAfterCommit) {
            faults.unknownPrepareAfterCommit = false;
            throw new HostStateCommitOutcomeUnknownError(
              "injected terminal-root preparation response loss",
              { cause: result },
            );
          }
          return result;
        },
        finalize: (request) => {
          const result = database.terminalRoot.finalize(request);
          faults.unknownFinalizeAfterCommit = false;
          throw new HostStateCommitOutcomeUnknownError(
            "injected terminal-root finalization response loss",
            { cause: result },
          );
        },
        reconcileOperation: (request) => database.terminalRoot.reconcileOperation(request),
        readOperation: (operationId) => database.terminalRoot.readOperation(operationId),
        readCertificate: (certificateId) => database.terminalRoot.readCertificate(certificateId),
        readCurrentCertificate: (serverId, leaseId) =>
          database.terminalRoot.readCurrentCertificate(serverId, leaseId),
        readInventory: () => database.terminalRoot.readInventory(),
      };
      return callback({ terminalRoot } as typeof database);
    },
    reopenAfterUnknownCommit: () => {
      faults.reopenCount += 1;
    },
  };
  const coordinatorFence = {
    collaborationServerId: server.collaborationServerId,
    coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
    coordinatorEpoch: coordinator.lease.coordinatorEpoch,
  } as const;
  const signer = createRuntimeOwnerKeyCustodySigner(new Uint8Array(32).fill(fill + 10));
  let nextHandleFill = fill + 11;
  const rpcLease = (record: typeof owner): RuntimeOwnerOperationContext["lease"] => ({
    machineIdentityId: MACHINE_IDENTITY_ID,
    runtimeOwnerServiceLeaseId: record.runtimeOwnerServiceLeaseId,
    runtimeOwnerServiceEpoch: record.runtimeOwnerServiceEpoch,
    ownerInstanceId: record.ownerInstanceId,
    ownerStartIdentitySchemaId: "remote-claw/linux-process-start-identity/v1",
    ownerStartIdentityRef: record.ownerProcessStartIdentityRef,
    ownerStartIdentityDigest: record.ownerProcessStartIdentityDigest,
    heartbeatDeadlineMs: record.heartbeatDeadlineMs,
  });
  const createContext = (
    lease = rpcLease(owner),
    register?: RuntimeOwnerOperationContext["callablePort"]["register"],
    invoke?: RuntimeOwnerOperationContext["callablePort"]["invoke"],
    signal: AbortSignal = new AbortController().signal,
  ): RuntimeOwnerOperationContext => {
    const context: RuntimeOwnerOperationContext = {
      lease,
      connectionId: base64urlEncode(new Uint8Array(16).fill(fill + 12)),
      requestId: `harness-request-${fill}`,
      signal,
      custodySigner: signer,
      callablePort: {
        register:
          register ??
          (() => ({
            protectedHandleId: canonicalId("protectedHandle", nextHandleFill++),
            kind: "callable_port",
          })),
        unregister: () => true,
        invoke:
          invoke ??
          (async (request) => ({
            ...request.request,
            resultSchemaId: "remote-claw/native-registration-port-probe-result/v1",
            resultRef: parseA1SafeId(`harness-proof-${fill}`),
            resultDigest: digest(fill + 13),
          })),
      },
      assertCurrent: () => context.lease,
    };
    return context;
  };
  const createOrchestrator = () =>
    createNativeRegistrationOrchestrator({
      database: access,
      coordinator: { fence: coordinatorFence, assertCurrent: () => coordinatorFence },
      adapter,
    });
  const execute = (
    orchestrator: ReturnType<typeof createNativeRegistrationOrchestrator>,
    name: string,
    payload: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ) => {
    const definition = orchestrator.operations.find((candidate) => candidate.name === name);
    if (definition === undefined) throw new Error(`missing ${name}`);
    return definition.execute(payload, context);
  };
  return {
    access,
    adapter,
    coordinatorFence,
    createContext,
    createOrchestrator,
    database,
    descriptor,
    execute,
    faults,
    owner,
    rpcLease,
    runtimeId,
    server,
    signer,
    state,
  };
}

type RegistrationHarness = Awaited<ReturnType<typeof createRegistrationHarness>>;

async function bringRegistrationReady(
  harness: RegistrationHarness,
  context: RuntimeOwnerOperationContext,
  orchestrator = harness.createOrchestrator(),
) {
  const leaseId = parseA1CanonicalId(
    "nativeConversationLease",
    harness.state.open.nativeConversationLeaseId,
  );
  await harness.execute(
    orchestrator,
    "native.registration.open",
    { operationId: "root-open", adapterRequest: { selector: "root" } },
    context,
  );
  const bound = (await harness.execute(
    orchestrator,
    "native.registration.bind",
    {
      operationId: "root-bind",
      nativeConversationLeaseId: leaseId,
      adapterRequest: { selector: "root" },
    },
    context,
  )) as Record<string, unknown>;
  await harness.execute(
    orchestrator,
    "native.registration.publish",
    {
      operationId: "root-publish",
      nativeConversationLeaseId: leaseId,
      nativeRegistrationPublicationId: "root-publication",
      publicationGeneration: 1,
      adapterRequest: { selector: "root" },
    },
    context,
  );
  const ready = (await harness.execute(
    orchestrator,
    "native.registration.ready",
    {
      operationId: "root-ready",
      nativeConversationLeaseId: leaseId,
      expectedGateGeneration: bound.gateGeneration as number,
      expectedPublicationId: "root-publication",
    },
    context,
  )) as Record<string, unknown>;
  return Object.freeze({ leaseId, orchestrator, ready });
}

describeLinux("trusted terminal-root activation orchestration", () => {
  it("activates, demotes, renews, and returns exact replays as historical facts", async () => {
    const harness = await createRegistrationHarness(90);
    const invocations: Parameters<RuntimeOwnerOperationContext["callablePort"]["invoke"]>[0][] = [];
    const context = harness.createContext(undefined, undefined, async (request) => {
      invocations.push(request);
      return {
        ...request.request,
        resultSchemaId: "remote-claw/native-registration-port-probe-result/v1",
        resultRef: parseA1SafeId(`root-proof-${invocations.length}`),
        resultDigest: digest(100 + invocations.length),
      };
    });
    try {
      const { leaseId, orchestrator, ready } = await bringRegistrationReady(harness, context);
      expect(
        orchestrator.operations.filter((operation) =>
          operation.name.startsWith("native.registration."),
        ),
      ).toHaveLength(8);
      expect(orchestrator.operations.map((operation) => operation.name)).toContain(
        "native.root.activate",
      );
      expect(orchestrator.operations).toHaveLength(9);
      expect(
        orchestrator.operations.filter((operation) => operation.name.startsWith("native.root.")),
      ).toHaveLength(1);
      const activationPayload = {
        operationId: "native-root-activate",
        kind: "activate",
        nativeConversationLeaseId: leaseId,
        expectedPriorRootPathCertificateId: null,
        ttlMs: 30_000,
      } as const;
      const proofsBeforeActivation = invocations.length;
      const activated = (await harness.execute(
        orchestrator,
        "native.root.activate",
        activationPayload,
        context,
      )) as Record<string, unknown>;
      expect(activated).toMatchObject({
        nativeConversationLeaseId: leaseId,
        state: "committed",
        replayed: false,
        livenessVerified: true,
      });
      expect(invocations).toHaveLength(proofsBeforeActivation + 1);
      expect(invocations.at(-1)).toMatchObject({
        nativeIncarnation: 1,
        attachmentLeaseId: parseA1SafeId(
          (harness.state.open.binding as { readonly attachmentLeaseId: string }).attachmentLeaseId,
        ),
        portGeneration: 1,
        request: {
          scopeKind: "native_binding",
          runtimeId: harness.runtimeId,
          operationSchemaId: "remote-claw/native-registration-port-probe/v1",
        },
      });
      expect(harness.database.terminalRoot.readInventory()).toMatchObject({
        operations: [{ state: "committed" }],
        certificates: [{ certificate: { rootPathCertificateId: activated.rootPathCertificateId } }],
      });

      const replayProofCount = invocations.length;
      await expect(
        harness.execute(orchestrator, "native.root.activate", activationPayload, context),
      ).resolves.toMatchObject({
        rootPathCertificateId: activated.rootPathCertificateId,
        replayed: true,
        livenessVerified: false,
      });
      expect(invocations).toHaveLength(replayProofCount);
      await expect(
        harness.execute(
          orchestrator,
          "native.root.activate",
          { ...activationPayload, ttlMs: 29_999 },
          context,
        ),
      ).rejects.toThrow(/request collided/);
      await expect(
        harness.execute(
          orchestrator,
          "native.root.activate",
          { ...activationPayload, unexpected: true } as never,
          context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      const recovered = (await harness.execute(
        orchestrator,
        "native.registration.recover",
        {
          operationId: "native-root-recover",
          nativeConversationLeaseId: leaseId,
          expectedGateGeneration: ready.gateGeneration as number,
        },
        context,
      )) as Record<string, unknown>;
      const demoted = harness.database.records.readTerminalReservation(
        harness.server.collaborationServerId,
        parseA1CanonicalId("registrationAttempt", harness.state.open.registrationAttemptId),
      );
      expect(demoted).toMatchObject({
        chat: { state: "recovering" },
        edge: { state: "installing", rootPathCertificateId: null },
      });
      const rereadied = (await harness.execute(
        orchestrator,
        "native.registration.ready",
        {
          operationId: "native-root-reready",
          nativeConversationLeaseId: leaseId,
          expectedGateGeneration: recovered.gateGeneration as number,
          expectedPublicationId: "root-publication",
        },
        context,
      )) as Record<string, unknown>;
      expect(rereadied).toMatchObject({ state: "ready" });
      const renewed = (await harness.execute(
        orchestrator,
        "native.root.activate",
        {
          operationId: "native-root-renew",
          kind: "renew",
          nativeConversationLeaseId: leaseId,
          expectedPriorRootPathCertificateId: activated.rootPathCertificateId as string,
          ttlMs: 30_000,
        },
        context,
      )) as Record<string, unknown>;
      expect(renewed).toMatchObject({ state: "committed", livenessVerified: true });
      expect(renewed.rootPathCertificateId).not.toBe(activated.rootPathCertificateId);
      expect(harness.database.terminalRoot.readInventory()).toMatchObject({
        operations: [{ state: "committed" }, { state: "committed" }],
      });
      expect(harness.database.terminalRoot.readInventory().certificates).toHaveLength(2);
    } finally {
      harness.signer.close();
      harness.database.close();
    }
  });

  it("keeps a preparation uncommitted on reverse-proof loss, disconnect, and stale authority", async () => {
    const harness = await createRegistrationHarness(120);
    let rejectProof = false;
    const controller = new AbortController();
    let abortProof = false;
    const rootProofs: Parameters<RuntimeOwnerOperationContext["callablePort"]["invoke"]>[0][] = [];
    const context = harness.createContext(
      undefined,
      undefined,
      async (request) => {
        if (rejectProof || abortProof) rootProofs.push(request);
        if (rejectProof) throw new Error("injected root proof loss");
        if (abortProof) controller.abort();
        return {
          ...request.request,
          resultSchemaId: "remote-claw/native-registration-port-probe-result/v1",
          resultRef: parseA1SafeId("root-proof-control"),
          resultDigest: digest(121),
        };
      },
      controller.signal,
    );
    try {
      const { leaseId, orchestrator } = await bringRegistrationReady(harness, context);
      const payload = {
        operationId: "native-root-proof-loss",
        kind: "activate",
        nativeConversationLeaseId: leaseId,
        expectedPriorRootPathCertificateId: null,
        ttlMs: 30_000,
      } as const;
      rejectProof = true;
      await expect(
        harness.execute(orchestrator, "native.root.activate", payload, context),
      ).rejects.toThrow(/injected root proof loss/);
      expect(harness.database.terminalRoot.readInventory()).toMatchObject({
        operations: [{ state: "prepared" }],
        certificates: [],
      });
      await expect(
        harness.execute(
          orchestrator,
          "native.root.activate",
          { ...payload, ttlMs: 29_999 },
          context,
        ),
      ).rejects.toThrow(/request collided/);

      rejectProof = false;
      abortProof = true;
      await expect(
        harness.execute(orchestrator, "native.root.activate", payload, context),
      ).rejects.toMatchObject({ code: "LIVE_PORT_UNAVAILABLE" });
      expect(rootProofs).toHaveLength(2);
      expect(rootProofs[0]?.request.operationRef).not.toBe(rootProofs[1]?.request.operationRef);
      expect(rootProofs[0]?.request.operationDigest).not.toBe(
        rootProofs[1]?.request.operationDigest,
      );
      expect(harness.database.terminalRoot.readInventory().certificates).toEqual([]);
      const staleContext: RuntimeOwnerOperationContext = {
        ...context,
        signal: new AbortController().signal,
        assertCurrent: () => {
          throw new Error("injected stale owner fence");
        },
      };
      await expect(
        harness.execute(
          orchestrator,
          "native.root.activate",
          { ...payload, operationId: "native-root-stale-owner" },
          staleContext,
        ),
      ).rejects.toThrow(/injected stale owner fence/);
      expect(harness.database.terminalRoot.readInventory().operations).toHaveLength(1);
    } finally {
      harness.signer.close();
      harness.database.close();
    }
  });

  it("reopens and reconciles a finalized certificate after its response is lost", async () => {
    const harness = await createRegistrationHarness(140);
    const context = harness.createContext();
    try {
      const { leaseId, orchestrator } = await bringRegistrationReady(harness, context);
      harness.faults.unknownFinalizeAfterCommit = true;
      const result = (await harness.execute(
        orchestrator,
        "native.root.activate",
        {
          operationId: "native-root-unknown-finalize",
          kind: "activate",
          nativeConversationLeaseId: leaseId,
          expectedPriorRootPathCertificateId: null,
          ttlMs: 30_000,
        },
        context,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({
        state: "committed",
        replayed: true,
        livenessVerified: false,
      });
      expect(harness.faults.reopenCount).toBe(1);
      expect(harness.database.terminalRoot.readInventory()).toMatchObject({
        operations: [{ state: "committed" }],
        certificates: [{}],
      });
    } finally {
      harness.signer.close();
      harness.database.close();
    }
  });

  it("reconciles a landed preparation once and fails closed when no preparation exists", async () => {
    const landed = await createRegistrationHarness(160);
    const landedContext = landed.createContext();
    try {
      const { leaseId, orchestrator } = await bringRegistrationReady(landed, landedContext);
      landed.faults.unknownPrepareAfterCommit = true;
      await expect(
        landed.execute(
          orchestrator,
          "native.root.activate",
          {
            operationId: "native-root-unknown-prepare-landed",
            kind: "activate",
            nativeConversationLeaseId: leaseId,
            expectedPriorRootPathCertificateId: null,
            ttlMs: 30_000,
          },
          landedContext,
        ),
      ).resolves.toMatchObject({ state: "committed", livenessVerified: true });
      expect(landed.faults.reopenCount).toBe(1);
      const runtimeInventory = landed.database.runtimeOwner.readInventory();
      expect(runtimeInventory.signatureReservations).toMatchObject([
        { purpose: "native_root", signerSequence: 0, state: "signed" },
      ]);
      expect(runtimeInventory.identityKeys).toMatchObject([{ nextSignerSequence: 1 }]);
      expect(landed.database.terminalRoot.readInventory().operations).toHaveLength(1);
    } finally {
      landed.signer.close();
      landed.database.close();
    }

    const absent = await createRegistrationHarness(180);
    const absentContext = absent.createContext();
    try {
      const { leaseId, orchestrator } = await bringRegistrationReady(absent, absentContext);
      absent.faults.unknownPrepareBeforeCommit = true;
      await expect(
        absent.execute(
          orchestrator,
          "native.root.activate",
          {
            operationId: "native-root-unknown-prepare-absent",
            kind: "activate",
            nativeConversationLeaseId: leaseId,
            expectedPriorRootPathCertificateId: null,
            ttlMs: 30_000,
          },
          absentContext,
        ),
      ).rejects.toMatchObject({ code: "COMMIT_NOT_RECONCILED" });
      expect(absent.faults.reopenCount).toBe(1);
      expect(absent.database.terminalRoot.readInventory()).toEqual({
        operations: [],
        certificates: [],
      });
      expect(absent.database.runtimeOwner.readInventory().signatureReservations).toEqual([]);
    } finally {
      absent.signer.close();
      absent.database.close();
    }
  });

  it("refuses finalization when the proven callable port is removed before the final fence check", async () => {
    const harness = await createRegistrationHarness(200);
    let afterProof: (() => Promise<void>) | null = null;
    const context = harness.createContext(undefined, undefined, async (request) => {
      const action = afterProof;
      afterProof = null;
      if (action !== null) await action();
      return {
        ...request.request,
        resultSchemaId: "remote-claw/native-registration-port-probe-result/v1",
        resultRef: parseA1SafeId("root-proof-before-port-removal"),
        resultDigest: digest(201),
      };
    });
    try {
      const { leaseId, orchestrator, ready } = await bringRegistrationReady(harness, context);
      afterProof = async () => {
        await harness.execute(
          orchestrator,
          "native.registration.close",
          {
            operationId: "native-root-proof-race-close",
            nativeConversationLeaseId: leaseId,
            expectedGateGeneration: ready.gateGeneration as number,
          },
          context,
        );
      };
      await expect(
        harness.execute(
          orchestrator,
          "native.root.activate",
          {
            operationId: "native-root-proof-race",
            kind: "activate",
            nativeConversationLeaseId: leaseId,
            expectedPriorRootPathCertificateId: null,
            ttlMs: 30_000,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "LIVE_PORT_UNAVAILABLE" });
      expect(harness.database.terminalRoot.readInventory()).toMatchObject({
        operations: [{ state: "prepared" }],
        certificates: [],
      });
      expect(harness.database.registration.readLease(leaseId)).toMatchObject({ state: "closed" });
    } finally {
      harness.signer.close();
      harness.database.close();
    }
  });
});

describeLinux("trusted native registration orchestration", () => {
  it("reattaches an unbound crash survivor with trusted successor setup and then binds it", async () => {
    const harness = await createRegistrationHarness(30);
    try {
      const firstContext = harness.createContext();
      const first = harness.createOrchestrator();
      await harness.execute(
        first,
        "native.registration.open",
        { operationId: "unbound-open", adapterRequest: { selector: "initial" } },
        firstContext,
      );
      const predecessorId = harness.state.open.nativeConversationLeaseId;
      expect(
        harness.database.registration.readLease(
          parseA1CanonicalId("nativeConversationLease", predecessorId),
        ),
      ).toMatchObject({
        nativeBindingIncarnationId: null,
        attachmentLeaseId: null,
      });

      const successorBinding = {
        nativeBindingIncarnationId: "binding-incarnation-unbound-successor",
        attachmentId: "attachment-unbound-successor",
        attachmentKind: "app-server",
        transportId: "transport-unbound-successor",
        attachmentGeneration: 1,
        attachmentLeaseId: "attachment-lease-unbound-successor",
        transportEpoch: 1,
        resourceOwnership: "shared_runtime",
        disconnectPolicy: "detach",
      } as const;
      harness.state.reattach = {
        ...harness.state.reattach,
        successorBinding,
      };
      // A fresh orchestrator models daemon memory loss: the durable starting lease remains, but its
      // old process-local callable port and setup candidate do not.
      const recovered = harness.createOrchestrator();
      const recoveredContext = harness.createContext();
      const reattached = (await harness.execute(
        recovered,
        "native.registration.reattach",
        {
          operationId: "unbound-reattach",
          predecessorNativeConversationLeaseId: predecessorId,
          adapterRequest: { selector: "recover-unbound" },
        },
        recoveredContext,
      )) as Record<string, unknown>;
      expect(reattached).toMatchObject({
        nativeConversationLeaseId: harness.state.reattach.nativeConversationLeaseId,
        portGeneration: 2,
        state: "recovering",
      });
      const successorId = parseA1CanonicalId(
        "nativeConversationLease",
        harness.state.reattach.nativeConversationLeaseId,
      );
      expect(harness.database.registration.readLease(successorId)).toMatchObject({
        nativeBindingIncarnationId: null,
        attachmentLeaseId: null,
      });
      const bound = (await harness.execute(
        recovered,
        "native.registration.bind",
        {
          operationId: "unbound-successor-bind",
          nativeConversationLeaseId: successorId,
          adapterRequest: { selector: "bind-recovered" },
        },
        recoveredContext,
      )) as Record<string, unknown>;
      expect(bound).toMatchObject({ state: "recovering", replayed: false });
      expect(harness.database.registration.readLease(successorId)).toMatchObject({
        nativeBindingIncarnationId: successorBinding.nativeBindingIncarnationId,
        attachmentLeaseId: successorBinding.attachmentLeaseId,
      });
    } finally {
      harness.signer.close();
      harness.database.close();
    }
  });

  it("reassigns the runtime and rotates the attachment on cross-owner bound reattach", async () => {
    const harness = await createRegistrationHarness(90);
    try {
      const predecessorContext = harness.createContext();
      const predecessorOrchestrator = harness.createOrchestrator();
      await harness.execute(
        predecessorOrchestrator,
        "native.registration.open",
        { operationId: "cross-owner-open", adapterRequest: { selector: "initial" } },
        predecessorContext,
      );
      await harness.execute(
        predecessorOrchestrator,
        "native.registration.bind",
        {
          operationId: "cross-owner-bind",
          nativeConversationLeaseId: harness.state.open.nativeConversationLeaseId,
          adapterRequest: { selector: "bind" },
        },
        predecessorContext,
      );
      const initialRuntime = harness.state.open.runtime as Readonly<Record<string, unknown>>;
      const predecessorAssignmentId = parseA1SafeId(initialRuntime.runtimeOwnerAssignmentId);
      harness.database.runtimeOwner.releaseServiceLease({
        fence: {
          runtimeOwnerServiceLeaseId: harness.owner.runtimeOwnerServiceLeaseId,
          runtimeOwnerServiceEpoch: harness.owner.runtimeOwnerServiceEpoch,
          ownerInstanceId: harness.owner.ownerInstanceId,
          ownerProcessStartIdentitySchemaId: harness.owner.ownerProcessStartIdentitySchemaId,
          ownerProcessStartIdentityRef: harness.owner.ownerProcessStartIdentityRef,
          ownerProcessStartIdentityDigest: harness.owner.ownerProcessStartIdentityDigest,
        },
        operation: operation("cross-owner-release", 105),
      });
      const successorOwner = harness.database.runtimeOwner.acquireServiceLease({
        candidateLeaseId: parseA1SafeId("cross-owner-successor-lease"),
        ownerInstanceId: parseA1SafeId("cross-owner-successor-instance"),
        ownerProcessStartIdentitySchemaId: "remote-claw/linux-process-start-identity/v1",
        ownerProcessStartIdentityRef: parseA1SafeId("cross-owner-successor-process"),
        ownerProcessStartIdentityDigest: digest(106),
        expectedCurrentLeaseId: null,
        expectedRuntimeOwnerServiceEpoch: harness.owner.runtimeOwnerServiceEpoch,
        leaseDurationMs: 60_000,
        operation: operation("cross-owner-acquire", 107),
      }).lease;
      const successorAssignmentId = parseA1SafeId("cross-owner-successor-assignment");
      const successorAttachmentLeaseId = parseA1SafeId("cross-owner-successor-attachment");
      harness.state.reattach = {
        ...harness.state.reattach,
        successorAttachmentLeaseId,
        expectedRuntimeOwnerAssignmentId: predecessorAssignmentId,
        runtimeOwnerAssignmentId: successorAssignmentId,
        reattachmentEvidenceSchemaId: "remote-claw/test/runtime-reattachment/v1",
        reattachmentEvidenceRef: "cross-owner-reattachment-ref",
        reattachmentEvidenceDigest: digest(108),
      };
      const successorContext = harness.createContext(harness.rpcLease(successorOwner));
      const successorOrchestrator = harness.createOrchestrator();
      const reattachPayload = {
        operationId: "cross-owner-reattach",
        predecessorNativeConversationLeaseId: harness.state.open.nativeConversationLeaseId,
        adapterRequest: { selector: "cross-owner" },
      } as const;
      const reattached = (await harness.execute(
        successorOrchestrator,
        "native.registration.reattach",
        reattachPayload,
        successorContext,
      )) as Record<string, unknown>;
      expect(reattached).toMatchObject({ portGeneration: 2, state: "recovering" });
      expect(
        harness.database.runtimeOwner
          .readInventory()
          .assignments.find(
            (assignment) => assignment.runtimeOwnerAssignmentId === successorAssignmentId,
          ),
      ).toMatchObject({
        runtimeOwnerServiceLeaseId: successorOwner.runtimeOwnerServiceLeaseId,
        supersedesRuntimeOwnerAssignmentId: predecessorAssignmentId,
      });
      expect(
        harness.database.registration.readLease(
          parseA1CanonicalId(
            "nativeConversationLease",
            harness.state.reattach.nativeConversationLeaseId,
          ),
        ),
      ).toMatchObject({
        attachmentLeaseId: successorAttachmentLeaseId,
        leaseGeneration: 2,
      });
      await expect(
        harness.execute(
          successorOrchestrator,
          "native.registration.reattach",
          reattachPayload,
          successorContext,
        ),
      ).resolves.toMatchObject({ replayed: true, portGeneration: 2 });

      harness.state.reattach = {
        ...harness.state.reattach,
        successorAttachmentLeaseId: parseA1SafeId("changed-successor-attachment"),
      };
      await expect(
        harness.execute(
          successorOrchestrator,
          "native.registration.reattach",
          reattachPayload,
          successorContext,
        ),
      ).rejects.toMatchObject({ code: "RESULT_MISMATCH" });
    } finally {
      harness.signer.close();
      harness.database.close();
    }
  });

  it("recovers a committed foundation across owner takeover and reuses the runtime for another mapping", async () => {
    const harness = await createRegistrationHarness(60);
    try {
      const initialRuntime = harness.state.open.runtime as Readonly<Record<string, unknown>>;
      const occupiedHandle = parseA1CanonicalId("protectedHandle", initialRuntime.signingKeyRef);
      const collidingContext = harness.createContext(undefined, () => ({
        protectedHandleId: occupiedHandle,
        kind: "callable_port",
      }));
      const initial = harness.createOrchestrator();
      const stableOpenPayload = {
        operationId: "takeover-open",
        adapterRequest: { selector: "takeover" },
      } as const;
      await expect(
        harness.execute(initial, "native.registration.open", stableOpenPayload, collidingContext),
      ).rejects.toThrow("callable-port protected handle is already allocated");
      const predecessorLeaseId = parseA1CanonicalId(
        "nativeConversationLease",
        harness.state.open.nativeConversationLeaseId,
      );
      expect(harness.database.registration.readLease(predecessorLeaseId)).toBeNull();
      expect(harness.database.runtimeOwner.readRuntime(harness.runtimeId)).not.toBeNull();

      const firstSelection = harness.state.open.selection;
      const firstSelectionRecord = firstSelection as Readonly<Record<string, unknown>>;
      harness.state.open = {
        ...harness.state.open,
        selection: { ...firstSelectionRecord, mappingEvidenceRef: "changed-mapping-evidence" },
      };
      await expect(
        harness.execute(
          harness.createOrchestrator(),
          "native.registration.open",
          stableOpenPayload,
          harness.createContext(),
        ),
      ).rejects.toMatchObject({ code: "RESULT_MISMATCH" });
      harness.state.open = { ...harness.state.open, selection: firstSelection };

      const oldFence = {
        runtimeOwnerServiceLeaseId: harness.owner.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: harness.owner.runtimeOwnerServiceEpoch,
        ownerInstanceId: harness.owner.ownerInstanceId,
        ownerProcessStartIdentitySchemaId: harness.owner.ownerProcessStartIdentitySchemaId,
        ownerProcessStartIdentityRef: harness.owner.ownerProcessStartIdentityRef,
        ownerProcessStartIdentityDigest: harness.owner.ownerProcessStartIdentityDigest,
      } as const;
      harness.database.runtimeOwner.releaseServiceLease({
        fence: oldFence,
        operation: operation("takeover-owner-release", 75),
      });
      const successorOwner = harness.database.runtimeOwner.acquireServiceLease({
        candidateLeaseId: parseA1SafeId("takeover-owner-lease"),
        ownerInstanceId: parseA1SafeId("takeover-owner-instance"),
        ownerProcessStartIdentitySchemaId: "remote-claw/linux-process-start-identity/v1",
        ownerProcessStartIdentityRef: parseA1SafeId("takeover-owner-process"),
        ownerProcessStartIdentityDigest: digest(76),
        expectedCurrentLeaseId: null,
        expectedRuntimeOwnerServiceEpoch: harness.owner.runtimeOwnerServiceEpoch,
        leaseDurationMs: 60_000,
        operation: operation("takeover-owner-acquire", 77),
      }).lease;
      const oldAssignmentId = parseA1SafeId(initialRuntime.runtimeOwnerAssignmentId);
      const successorAssignmentId = parseA1SafeId("runtime-assignment-takeover");
      const successorRuntime = {
        ...initialRuntime,
        expectedRuntimeOwnerAssignmentId: oldAssignmentId,
        runtimeOwnerAssignmentId: successorAssignmentId,
        reattachmentEvidenceSchemaId: "remote-claw/test/runtime-reattachment/v1",
        reattachmentEvidenceRef: "runtime-reattachment-ref",
        reattachmentEvidenceDigest: digest(78),
      } as const;
      harness.state.open = { ...harness.state.open, runtime: successorRuntime };
      const successorLease = harness.rpcLease(successorOwner);

      // The reassignment foundation lands, but the same durable handle collision prevents the
      // registration lease. A same-operation retry must accept the already-landed reassignment.
      await expect(
        harness.execute(
          harness.createOrchestrator(),
          "native.registration.open",
          stableOpenPayload,
          harness.createContext(successorLease, () => ({
            protectedHandleId: occupiedHandle,
            kind: "callable_port",
          })),
        ),
      ).rejects.toThrow("callable-port protected handle is already allocated");
      expect(
        harness.database.runtimeOwner
          .readInventory()
          .assignments.find(
            (assignment) => assignment.runtimeOwnerAssignmentId === successorAssignmentId,
          ),
      ).toMatchObject({
        runtimeOwnerAssignmentId: successorAssignmentId,
        runtimeOwnerServiceLeaseId: successorOwner.runtimeOwnerServiceLeaseId,
      });
      const successorContext = harness.createContext(successorLease);
      const successor = harness.createOrchestrator();
      await expect(
        harness.execute(successor, "native.registration.open", stableOpenPayload, successorContext),
      ).resolves.toMatchObject({ state: "starting" });

      const firstReservation = harness.database.records.readTerminalReservation(
        harness.server.collaborationServerId,
        parseA1CanonicalId("registrationAttempt", harness.state.open.registrationAttemptId),
      );
      if (firstReservation === null) throw new Error("missing first reservation");
      harness.state.open = {
        ...harness.state.open,
        registrationAttemptId: canonicalId("registrationAttempt", 79),
        selection: {
          kind: "existing_mapping",
          projectId: firstReservation.project.projectId,
          workspaceSelectorId: firstReservation.mapping.workspaceSelectorId,
          projectTargetSelectorMappingId: firstReservation.mapping.projectTargetSelectorMappingId,
          mappingGeneration: firstReservation.mapping.mappingGeneration,
          targetDigest: firstReservation.mapping.targetDigest,
          parentChatId: firstReservation.chat.logicalChatId,
        },
        runtime: {
          ...successorRuntime,
          expectedRuntimeOwnerAssignmentId: null,
          reattachmentEvidenceSchemaId: null,
          reattachmentEvidenceRef: null,
          reattachmentEvidenceDigest: null,
        },
        binding: {
          nativeBindingIncarnationId: "shared-binding-incarnation",
          attachmentId: "shared-attachment",
          attachmentKind: "app-server",
          transportId: "shared-transport",
          attachmentGeneration: 1,
          attachmentLeaseId: "shared-attachment-lease",
          transportEpoch: 1,
          resourceOwnership: "shared_runtime",
          disconnectPolicy: "detach",
        },
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 80),
      };
      const sharedMeasurement = harness.state.open;
      harness.state.open = { ...sharedMeasurement, runtime: successorRuntime };
      await expect(
        harness.execute(
          harness.createOrchestrator(),
          "native.registration.open",
          { operationId: "shared-runtime-open", adapterRequest: { selector: "shared" } },
          successorContext,
        ),
      ).rejects.toMatchObject({ code: "RESULT_MISMATCH" });
      harness.state.open = {
        ...sharedMeasurement,
        runtime: {
          ...(sharedMeasurement.runtime as Readonly<Record<string, RuntimeOwnerRpcJsonValue>>),
          signingKeyRef: canonicalId("protectedHandle", 81),
        },
      };
      await expect(
        harness.execute(
          harness.createOrchestrator(),
          "native.registration.open",
          { operationId: "shared-runtime-open", adapterRequest: { selector: "shared" } },
          successorContext,
        ),
      ).rejects.toMatchObject({ code: "RESULT_MISMATCH" });
      harness.state.open = sharedMeasurement;
      const shared = (await harness.execute(
        successor,
        "native.registration.open",
        { operationId: "shared-runtime-open", adapterRequest: { selector: "shared" } },
        successorContext,
      )) as Record<string, unknown>;
      expect(shared).toMatchObject({ projectId: firstReservation.project.projectId });
      expect(
        harness.database.runtimeOwner
          .readInventory()
          .journal.filter((entry) => entry.entryKind === "runtime_registered"),
      ).toHaveLength(1);
    } finally {
      harness.signer.close();
      harness.database.close();
    }
  });

  it("keeps open unbound, exact-replays its live handle, then binds, publishes, and proves ready", async () => {
    const environment = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: environment,
    });
    const server = database.records.ensureDefaultCollaborationServer().server;
    const coordinator = database.records.acquireCoordinatorLease({
      collaborationServerId: server.collaborationServerId,
      candidateLeaseId: canonicalId("coordinatorLease", 1),
      ownerInstanceId: parseA1SafeId("registration-test-coordinator"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 60_000,
    });
    const ownerRequest = {
      candidateLeaseId: parseA1SafeId("registration-test-owner-lease"),
      ownerInstanceId: parseA1SafeId("registration-test-owner-instance"),
      ownerProcessStartIdentitySchemaId: "remote-claw/linux-process-start-identity/v1",
      ownerProcessStartIdentityRef: parseA1SafeId("registration-test-owner-process"),
      ownerProcessStartIdentityDigest: digest(2),
      expectedCurrentLeaseId: null,
      expectedRuntimeOwnerServiceEpoch: 0,
      leaseDurationMs: 60_000,
      operation: operation("owner-acquire", 3),
    } as const;
    const owner = database.runtimeOwner.acquireServiceLease(ownerRequest).lease;
    const wardenLaunchNonce = parseWardenLaunchNonce(base64urlEncode(new Uint8Array(32).fill(4)));
    const startIdentityDigest = digest(5);
    const runtimeId = await nativeRuntimeId({
      wardenLaunchNonce,
      startIdentitySchemaId: "remote-claw/test/native-start/v1",
      startIdentityDigest,
    });
    const metadataBytes = Uint8Array.of(1, 4, 4);
    const measurement = {
      registrationAttemptId: canonicalId("registrationAttempt", 6),
      descriptor: { product: "codex", access: "app-server" },
      initialPhase: "starting",
      expectedNativeRef: {
        descriptor: { product: "codex", access: "app-server" },
        runtimeId,
        conversationId: "semantic-thread-one",
        incarnation: 1,
      },
      selection: {
        kind: "first_bootstrap",
        workspaceSelectorId: "workspace-main",
        terminalProjectRef: "terminal-project-main",
        mappingEvidenceRef: "mapping-evidence-main",
      },
      metadata: {
        schemaId: "remote-claw/test/provider-metadata/v1",
        bytes: base64urlEncode(metadataBytes),
      },
      runtime: {
        runtimeId,
        nativeIncarnation: 1,
        wardenLaunchNonce,
        startIdentitySchemaId: "remote-claw/test/native-start/v1",
        startIdentityRef: "native-start-ref",
        startIdentityDigest,
        runtimeOwnerAssignmentId: "runtime-assignment-one",
        expectedRuntimeOwnerAssignmentId: null,
        reattachmentEvidenceSchemaId: null,
        reattachmentEvidenceRef: null,
        reattachmentEvidenceDigest: null,
        signingKeyRef: canonicalId("protectedHandle", 7),
        localTrustEvidenceRef: "local-trust-ref",
        localTrustEvidenceDigest: digest(8),
      },
      binding: {
        nativeBindingIncarnationId: "binding-incarnation-one",
        attachmentId: "attachment-one",
        attachmentKind: "app-server",
        transportId: "transport-one",
        attachmentGeneration: 1,
        attachmentLeaseId: "attachment-lease-one",
        transportEpoch: 1,
        resourceOwnership: "shared_runtime",
        disconnectPolicy: "detach",
      },
      nativeConversationLeaseId: canonicalId("nativeConversationLease", 9),
    } as const;
    const adapter: NativeRegistrationAdapter = {
      measureOpen: () => measurement,
      measureBinding: (selector) => ({
        nativeRef: {
          descriptor: { product: "codex", access: "app-server" },
          runtimeId,
          conversationId:
            (selector as { readonly setup?: unknown }).setup === "changed"
              ? "semantic-thread-changed"
              : "semantic-thread-one",
          incarnation: 1,
        },
        localTransitionId: "local-transition-one",
        localNativeConversationId: "local-conversation-one",
        parentLocalNativeConversationId: null,
      }),
      measurePublication: () => ({
        metadataSchemaId: measurement.metadata.schemaId,
        metadataBytes,
        capabilities: {
          version: 1,
          mutationAdmission: "structured",
          history: "complete",
          deliveryEvidence: "structured_receipt",
          liveReattach: true,
        },
      }),
      measureReattach: () => ({
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 10),
        successorAttachmentLeaseId: null,
        successorBinding: null,
        expectedRuntimeOwnerAssignmentId: null,
        runtimeOwnerAssignmentId: null,
        reattachmentEvidenceSchemaId: null,
        reattachmentEvidenceRef: null,
        reattachmentEvidenceDigest: null,
      }),
    };
    const access: NativeRegistrationDatabaseAccess = {
      use: (callback) => callback(database),
      reopenAfterUnknownCommit: () => {
        throw new Error("unexpected unknown commit");
      },
    };
    const coordinatorFence = {
      collaborationServerId: server.collaborationServerId,
      coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
      coordinatorEpoch: coordinator.lease.coordinatorEpoch,
    } as const;
    const signer = createRuntimeOwnerKeyCustodySigner(new Uint8Array(32).fill(11));
    let invokeCount = 0;
    let registrationCount = 0;
    const callablePortRef = {
      protectedHandleId: canonicalId("protectedHandle", 12),
      kind: "callable_port",
    } as const;
    const context: RuntimeOwnerOperationContext = {
      lease: {
        machineIdentityId: MACHINE_IDENTITY_ID,
        runtimeOwnerServiceLeaseId: owner.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: owner.runtimeOwnerServiceEpoch,
        ownerInstanceId: owner.ownerInstanceId,
        ownerStartIdentitySchemaId: "remote-claw/linux-process-start-identity/v1",
        ownerStartIdentityRef: owner.ownerProcessStartIdentityRef,
        ownerStartIdentityDigest: owner.ownerProcessStartIdentityDigest,
        heartbeatDeadlineMs: owner.heartbeatDeadlineMs,
      },
      connectionId: base64urlEncode(new Uint8Array(16).fill(13)),
      requestId: "request-one",
      signal: new AbortController().signal,
      custodySigner: signer,
      callablePort: {
        register: () => {
          registrationCount += 1;
          return {
            protectedHandleId: canonicalId("protectedHandle", 11 + registrationCount),
            kind: "callable_port",
          } as const;
        },
        unregister: () => true,
        invoke: async (request) => {
          invokeCount += 1;
          if (invokeCount === 4) throw new Error("simulated post-ready proof loss");
          return {
            ...request.request,
            resultSchemaId: "remote-claw/native-registration-port-probe-result/v1",
            resultRef: parseA1SafeId(`probe-result-${invokeCount}`),
            resultDigest: digest(20 + invokeCount),
          };
        },
      },
      assertCurrent: () => context.lease,
    };
    const orchestrator = createNativeRegistrationOrchestrator({
      database: access,
      coordinator: { fence: coordinatorFence, assertCurrent: () => coordinatorFence },
      adapter,
    });
    const execute = (
      name: string,
      payload: RuntimeOwnerRpcJsonValue,
      operationContext = context,
    ) => {
      const operation = orchestrator.operations.find((candidate) => candidate.name === name);
      if (operation === undefined) throw new Error(`missing ${name}`);
      return operation.execute(payload, operationContext);
    };
    const openPayload = { operationId: "open-one", adapterRequest: { selector: "one" } } as const;
    const opened = (await execute("native.registration.open", openPayload)) as Record<
      string,
      unknown
    >;
    expect(opened.callablePortRef).toEqual(callablePortRef);
    expect(database.registration.readLease(measurement.nativeConversationLeaseId)).toMatchObject({
      state: "starting",
      nativeBindingIncarnationId: null,
      attachmentLeaseId: null,
    });
    const replayedOpen = (await execute("native.registration.open", openPayload)) as Record<
      string,
      unknown
    >;
    expect(replayedOpen).toMatchObject({ callablePortRef, replayed: true });

    const otherContext: RuntimeOwnerOperationContext = {
      ...context,
      connectionId: base64urlEncode(new Uint8Array(16).fill(14)),
    };
    await expect(
      execute(
        "native.registration.bind",
        {
          operationId: "bind-cross-connection",
          nativeConversationLeaseId: measurement.nativeConversationLeaseId,
          adapterRequest: { setup: "one" },
        },
        otherContext,
      ),
    ).rejects.toMatchObject({ code: "LIVE_PORT_UNAVAILABLE" });

    const bound = (await execute("native.registration.bind", {
      operationId: "bind-one",
      nativeConversationLeaseId: measurement.nativeConversationLeaseId,
      adapterRequest: { setup: "one" },
    })) as Record<string, unknown>;
    expect(bound).toMatchObject({ state: "starting", replayed: false });
    await expect(
      execute("native.registration.bind", {
        operationId: "bind-one",
        nativeConversationLeaseId: measurement.nativeConversationLeaseId,
        adapterRequest: { setup: "changed" },
      }),
    ).rejects.toMatchObject({ code: "RESULT_MISMATCH" });
    const publicationId = "publication-one";
    const published = (await execute("native.registration.publish", {
      operationId: "publish-one",
      nativeConversationLeaseId: measurement.nativeConversationLeaseId,
      nativeRegistrationPublicationId: publicationId,
      publicationGeneration: 1,
      adapterRequest: { publish: "one" },
    })) as Record<string, unknown>;
    expect(published).toMatchObject({
      nativeRegistrationPublicationId: publicationId,
      replayed: false,
    });
    const replayedPublication = (await execute("native.registration.publish", {
      operationId: "publish-one",
      nativeConversationLeaseId: measurement.nativeConversationLeaseId,
      nativeRegistrationPublicationId: publicationId,
      publicationGeneration: 1,
      adapterRequest: { publish: "one" },
    })) as Record<string, unknown>;
    expect(replayedPublication).toMatchObject({ replayed: true });
    const firstReadyPayload = {
      operationId: "ready-one",
      nativeConversationLeaseId: measurement.nativeConversationLeaseId,
      expectedGateGeneration: bound.gateGeneration as number,
      expectedPublicationId: publicationId,
    } as const;
    await expect(execute("native.registration.ready", firstReadyPayload)).rejects.toMatchObject({
      code: "LIVE_PORT_UNAVAILABLE",
    });
    const compensatedReady = (await execute(
      "native.registration.ready",
      firstReadyPayload,
    )) as Record<string, unknown>;
    expect(compensatedReady).toMatchObject({
      state: "recovering",
      gateGeneration: (bound.gateGeneration as number) + 2,
      replayed: true,
    });
    const secondReadyPayload = {
      operationId: "ready-two",
      nativeConversationLeaseId: measurement.nativeConversationLeaseId,
      expectedGateGeneration: compensatedReady.gateGeneration as number,
      expectedPublicationId: publicationId,
    } as const;
    const ready = (await execute("native.registration.ready", secondReadyPayload)) as Record<
      string,
      unknown
    >;
    expect(ready).toMatchObject({ state: "ready", replayed: false });
    const replayedReady = (await execute(
      "native.registration.ready",
      secondReadyPayload,
    )) as Record<string, unknown>;
    expect(replayedReady).toMatchObject({
      state: "ready",
      gateGeneration: ready.gateGeneration,
      replayed: true,
    });
    expect(invokeCount).toBe(7);
    expect(database.registration.readLease(measurement.nativeConversationLeaseId)?.state).toBe(
      "ready",
    );
    const recovered = (await execute("native.registration.recover", {
      operationId: "recover-one",
      nativeConversationLeaseId: measurement.nativeConversationLeaseId,
      expectedGateGeneration: ready.gateGeneration as number,
    })) as Record<string, unknown>;
    expect(recovered).toMatchObject({ state: "recovering", replayed: false });
    const drained = (await execute("native.registration.drain", {
      operationId: "drain-one",
      nativeConversationLeaseId: measurement.nativeConversationLeaseId,
      expectedGateGeneration: recovered.gateGeneration as number,
    })) as Record<string, unknown>;
    expect(drained).toMatchObject({ state: "draining", replayed: false });
    const closePayload = {
      operationId: "close-one",
      nativeConversationLeaseId: measurement.nativeConversationLeaseId,
      expectedGateGeneration: drained.gateGeneration as number,
    } as const;
    const closed = (await execute("native.registration.close", closePayload)) as Record<
      string,
      unknown
    >;
    expect(closed).toMatchObject({ state: "closed", replayed: false });
    await expect(execute("native.registration.close", closePayload)).resolves.toMatchObject({
      state: "closed",
      replayed: true,
    });
    const reattached = (await execute("native.registration.reattach", {
      operationId: "reattach-one",
      predecessorNativeConversationLeaseId: measurement.nativeConversationLeaseId,
      adapterRequest: { recover: "one" },
    })) as Record<string, unknown>;
    expect(reattached).toMatchObject({
      nativeConversationLeaseId: canonicalId("nativeConversationLease", 10),
      portGeneration: 2,
      state: "recovering",
      replayed: false,
    });
    signer.close();
    database.close();
  });
});
