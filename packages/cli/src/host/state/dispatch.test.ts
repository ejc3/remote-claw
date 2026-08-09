import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertDispatchReceiptMatches,
  NATIVE_BINDING_MUTATION_FAMILIES,
  type NativeDispatchReceipt,
  type NativeFirstDispatchCapability,
  type NativeReconciliationCapability,
  nativeDeliveryAttemptId,
  nativeFrontDoorDispatchDigest,
  parseA1NativeConversationRef,
  parseA1NativeMutationFence,
  parseNativeCommandEffectGateRecord,
  parseNativeDeliveryAttemptRecord,
  parseNativeDispatchReceipt,
  parseNativeDispatchReceiptExpectation,
  parseNativeFrontDoorDispatchRecord,
  parseNativeReconciliationEvidence,
  parsePreparedNativeMutation,
  verifyNativeDeliveryAttemptId,
  verifyNativeFrontDoorDispatchDigest,
} from "./dispatch.js";
import {
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseDispatchAuthorization,
} from "./ids.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function noncanonicalTailAlias(value: string): string {
  const last = value.at(-1);
  const index = last === undefined ? -1 : BASE64URL_ALPHABET.indexOf(last);
  const replacement = BASE64URL_ALPHABET.at(index + 1);
  if (index < 0 || index % 4 !== 0 || replacement === undefined) {
    throw new Error("expected a canonical 32-byte base64url value");
  }
  return `${value.slice(0, -1)}${replacement}`;
}

const collaborationServerId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
const logicalChatId = parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 2)}`);
const inwardEdgeId = parseA1CanonicalId("inwardEdge", `rcie_${encoded(16, 8)}`);
const nativeBindingId = parseA1CanonicalId("nativeBinding", `rcnb_${encoded(16, 3)}`);
const coordinatorLeaseId = parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 4)}`);
const nativeRuntimeId = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 4)}`);
const attemptId = parseA1CanonicalId("nativeDeliveryAttempt", `nat_${encoded(32, 5)}`);
const otherAttemptId = parseA1CanonicalId("nativeDeliveryAttempt", `nat_${encoded(32, 6)}`);
const dispatchAuthorizationRef = {
  protectedHandleId: parseA1CanonicalId("protectedHandle", `rcph_${encoded(16, 7)}`),
  kind: "dispatch_authorization",
} as const;
const openCodeActionId = parseA1SafeId(`msg_${encoded(16, 7)}`);

function digest(fill: number) {
  return parseA1Digest(encoded(32, fill));
}

function authorization(fill: number) {
  return parseDispatchAuthorization(encoded(32, fill));
}

const nativeRef = {
  descriptor: { product: "codex", access: "app-server" },
  runtimeId: nativeRuntimeId,
  conversationId: "thread-1",
  incarnation: 0,
} as const;

const fence = {
  collaborationServerId,
  logicalChatId,
  nativeBindingId,
  inwardEdgeId,
  topologyGeneration: 2,
  coordinatorLeaseId,
  coordinatorEpoch: 3,
  attemptId,
  nativeRef,
  attachmentLeaseId: "attachment-lease-1",
  capabilitySnapshotId: "capability-snapshot-1",
} as const;

const prepared = {
  attemptId,
  dispatchAuthorizationHandle: authorization(7),
  canonicalDispatchDigest: digest(26),
  fence,
  canonicalRequestSchemaId: "remote-claw/codex-request/v1",
  canonicalRequestRef: "canonical-request-1",
  canonicalRequestDigest: digest(8),
} as const;

function deliveryAttemptFixture() {
  return {
    nativeDeliveryAttemptId: attemptId,
    commandId: parseA1SafeId("command-1"),
    admittingCommandResultId: "command-result-1",
    admittingCommandResultSignedRecordDigest: digest(9),
    canonicalCommandRecordDigest: digest(10),
    decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1",
    decisionEvidenceDigest: digest(11),
    collaborationServerId,
    logicalChatId,
    nativeBindingId,
    descriptor: { product: "opencode", access: "server" },
    runtimeId: nativeRuntimeId,
    nativeIncarnation: 0,
    nativeConversationId: "session-1",
    attachmentLeaseId: "attachment-lease-1",
    nativeClientIngressLeaseId: "ingress-lease-1",
    capabilitySnapshotId: "capability-snapshot-1",
    capabilitySnapshotAttestationDigest: digest(12),
    capabilityFamilyDigest: digest(13),
    mutationFamily: "user_text",
    canonicalCommandPayloadSchemaId: "remote-claw/user-text/v1",
    canonicalCommandPayloadDigest: digest(14),
    nativeRequestTranslatorDigest: digest(15),
    nativeActionId: openCodeActionId,
    nativeMethod: "session.prompt",
    nativeRouteSchemaId: "remote-claw/opencode-route/v1",
    canonicalRequestSchemaId: "remote-claw/opencode-request/v1",
    canonicalRequestRef: "canonical-request-1",
    canonicalRequestDigest: digest(16),
    nativeRequestTranslationSchemaId: "remote-claw/native-request-translation/v1",
    nativeRequestTranslationRef: "native-translation-1",
    nativeRequestTranslationDigest: digest(17),
    nativeTargetPathDigest: digest(18),
    positiveReadBackSchemaId: "remote-claw/opencode-user-text-read-back/v1",
    expectedNativePartCount: 1,
    expectedNativePartFingerprintSchemaId: "remote-claw/opencode-expected-user-part-vector/v1",
    expectedNativePartFingerprintVectorRef: "part-fingerprint-vector-1",
    expectedNativePartFingerprintVectorDigest: digest(19),
    state: "prepared",
    claimedByCoordinatorEpoch: null,
    transportReceiptRef: null,
    nativeReadBackEvidenceRef: null,
    nativeReadBackEvidenceDigest: null,
    outcomeEvidenceSchemaId: null,
    outcomeEvidenceRef: null,
    outcomeEvidenceDigest: null,
  } as const;
}

function effectGateFixture() {
  return {
    commandId: "command-1",
    admittingCommandResultId: "command-result-1",
    admittingCommandResultSignedRecordDigest: digest(20),
    canonicalCommandRecordDigest: digest(21),
    decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1",
    decisionEvidenceDigest: digest(22),
    collaborationServerId,
    logicalChatId,
    state: "never_started",
    startedAttemptId: null,
    outcomeEvidenceSchemaId: null,
    outcomeEvidenceRef: null,
    outcomeEvidenceDigest: null,
  } as const;
}

async function frontDoorFixture() {
  const committed = {
    nativeDeliveryAttemptId: attemptId,
    nativeClientIngressLeaseId: parseA1SafeId("ingress-lease-1"),
    nativeTargetPathDigest: digest(23),
    canonicalRequestDigest: digest(24),
    nativeRequestTranslationDigest: digest(25),
    dispatchAuthorizationRef,
  };
  return {
    ...committed,
    canonicalDispatchDigest: await nativeFrontDoorDispatchDigest(committed),
    dispatchState: "not_started",
    dispatchStartedAtMs: null,
    nativeReceiptRef: null,
    outcomeEvidenceSchemaId: null,
    outcomeEvidenceRef: null,
    outcomeEvidenceDigest: null,
  } as const;
}

describe("native mutation boundary records", () => {
  it("accepts and freezes a complete conversation reference, fence, and prepared mutation", () => {
    for (const parsed of [
      parseA1NativeConversationRef(nativeRef),
      parseA1NativeMutationFence(fence),
      parsePreparedNativeMutation(prepared),
    ]) {
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    expect(parsePreparedNativeMutation(prepared)).toEqual(prepared);
  });

  it("rejects invalid native descriptors, non-positive fence generations, and mismatched attempts", () => {
    expect(() =>
      parseA1NativeConversationRef({
        ...nativeRef,
        descriptor: { product: "claude-code", access: "app-server" },
      }),
    ).toThrow(/unsupported product\/access/);
    expect(() =>
      parseA1NativeConversationRef({
        ...nativeRef,
        runtimeId: nativeBindingId,
      }),
    ).toThrow(/rcrt_/);
    expect(() => parseA1NativeMutationFence({ ...fence, topologyGeneration: 0 })).toThrow(
      /greater than zero/,
    );
    expect(() =>
      parseA1NativeMutationFence({
        ...fence,
        inwardEdgeId: "inward-edge-1",
      }),
    ).toThrow(/rcie_/);
    expect(() =>
      parsePreparedNativeMutation({
        ...prepared,
        attemptId: otherAttemptId,
      }),
    ).toThrow(/must match the prepared attempt/);
    expect(() =>
      parsePreparedNativeMutation({
        ...prepared,
        futureDispatchMode: "unsafe",
      }),
    ).toThrow(/exactly the selected fields/);
  });

  it("enforces the receipt lifecycle and keeps receipt evidence atomic", () => {
    const started = {
      attemptId,
      canonicalDispatchDigest: digest(26),
      dispatchState: "started",
      nativeReceiptRef: null,
      nativeReceiptDigest: null,
    };
    const receiptEvidence = {
      nativeReceiptRef: "native-receipt-1",
      nativeReceiptDigest: digest(27),
    };
    const validCases = [
      { name: "started without a receipt", value: started },
      {
        name: "transport receipt with evidence",
        value: { ...started, dispatchState: "transport_receipt", ...receiptEvidence },
      },
      {
        name: "native observed with evidence",
        value: { ...started, dispatchState: "native_observed", ...receiptEvidence },
      },
      {
        name: "completed with evidence",
        value: { ...started, dispatchState: "completed", ...receiptEvidence },
      },
      {
        name: "outcome unknown before a receipt",
        value: { ...started, dispatchState: "outcome_unknown" },
      },
      {
        name: "outcome unknown after a receipt",
        value: { ...started, dispatchState: "outcome_unknown", ...receiptEvidence },
      },
    ] as const;

    for (const { name, value } of validCases) {
      expect(parseNativeDispatchReceipt(value), name).toEqual(value);
    }
    expect(() =>
      parseNativeDispatchReceipt({
        ...started,
        dispatchState: "completed",
        ...receiptEvidence,
        nativeReceiptDigest: null,
      }),
    ).toThrow(/reference and digest/);
    expect(() =>
      parseNativeDispatchReceipt({
        ...started,
        ...receiptEvidence,
      }),
    ).toThrow(/must be null before/);
    for (const dispatchState of ["transport_receipt", "native_observed", "completed"] as const) {
      expect(
        () => parseNativeDispatchReceipt({ ...started, dispatchState }),
        `${dispatchState} without receipt evidence`,
      ).toThrow(/must be present/);
    }
    expect(() =>
      parseNativeDispatchReceipt({
        ...started,
        dispatchState: "outcome_unknown",
        nativeReceiptRef: "native-receipt-1",
      }),
    ).toThrow(/reference and digest/);
    expect(() =>
      parseNativeDispatchReceipt({
        ...started,
        dispatchAuthorizationHandle: authorization(7),
      }),
    ).toThrow(/exactly the selected fields/);
  });

  it("matches receipts to both the attempt and canonical dispatch digest", () => {
    const durableExpectation = parseNativeDispatchReceiptExpectation({
      attemptId: prepared.attemptId,
      canonicalDispatchDigest: prepared.canonicalDispatchDigest,
    });
    const receipt = parseNativeDispatchReceipt({
      attemptId,
      canonicalDispatchDigest: digest(26),
      dispatchState: "completed",
      nativeReceiptRef: "native-receipt-1",
      nativeReceiptDigest: digest(27),
    });

    expect(() => assertDispatchReceiptMatches(durableExpectation, receipt)).not.toThrow();
    expect(() =>
      assertDispatchReceiptMatches(durableExpectation, {
        ...receipt,
        attemptId: otherAttemptId,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      assertDispatchReceiptMatches(durableExpectation, {
        ...receipt,
        canonicalDispatchDigest: digest(28),
      }),
    ).toThrow(/does not match/);
    expect(() =>
      assertDispatchReceiptMatches(durableExpectation, {
        ...receipt,
        canonicalDispatchDigest: noncanonicalTailAlias(receipt.canonicalDispatchDigest),
      } as unknown as NativeDispatchReceipt),
    ).toThrow(/canonical/);
    expect(() =>
      parseNativeDispatchReceiptExpectation({
        ...durableExpectation,
        dispatchAuthorizationHandle: prepared.dispatchAuthorizationHandle,
      }),
    ).toThrow(/exactly the selected fields/);
  });

  it("keeps first dispatch and evidence-only reconciliation capabilities separate", () => {
    expectTypeOf<keyof NativeFirstDispatchCapability>().toEqualTypeOf<"dispatch">();
    expectTypeOf<keyof NativeReconciliationCapability>().toEqualTypeOf<"reconcile">();
    expectTypeOf<
      "dispatch" extends keyof NativeReconciliationCapability ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "reconcile" extends keyof NativeFirstDispatchCapability ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "dispatchAuthorizationHandle" extends keyof NativeDispatchReceipt ? true : false
    >().toEqualTypeOf<false>();

    const evidence = {
      attemptId,
      nativeEvidenceSchemaId: "remote-claw/native-evidence/v1",
      nativeEvidenceRef: "native-evidence-1",
      nativeEvidenceDigest: digest(29),
    };
    expect(parseNativeReconciliationEvidence(evidence)).toEqual(evidence);
    expect(() =>
      parseNativeReconciliationEvidence({
        ...evidence,
        dispatchAuthorizationHandle: authorization(7),
      }),
    ).toThrow(/exactly the selected fields/);

    const durableExpectation = parseNativeDispatchReceiptExpectation({
      attemptId: evidence.attemptId,
      canonicalDispatchDigest: prepared.canonicalDispatchDigest,
    });
    const reconciliationReceipt = parseNativeDispatchReceipt({
      ...durableExpectation,
      dispatchState: "native_observed",
      nativeReceiptRef: "native-evidence-1",
      nativeReceiptDigest: evidence.nativeEvidenceDigest,
    });
    expect(() =>
      assertDispatchReceiptMatches(durableExpectation, reconciliationReceipt),
    ).not.toThrow();
  });
});

describe("native delivery attempt and effect gate records", () => {
  it("selects every chat-scoped native mutation family and excludes server-scoped new_chat", () => {
    expect(Object.isFrozen(NATIVE_BINDING_MUTATION_FAMILIES)).toBe(true);
    expect(NATIVE_BINDING_MUTATION_FAMILIES).toEqual([
      "user_text",
      "steer_text",
      "blank_submit",
      "attachment",
      "clear",
      "interrupt",
      "compact",
      "permission_answer",
      "question_answer",
      "set_model",
      "set_mode",
      "end",
      "fork",
      "archive",
      "unarchive",
      "revert",
      "unrevert",
      "shell",
      "session_command",
      "message_mutation",
      "part_mutation",
      "share",
      "rename",
      "delete",
    ]);
    expect(NATIVE_BINDING_MUTATION_FAMILIES).not.toContain("new_chat");
  });

  it("accepts and freezes a complete prepared delivery attempt", () => {
    const value = deliveryAttemptFixture();
    const parsed = parseNativeDeliveryAttemptRecord(value);

    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("derives and verifies the one allowed attempt ID for its command tuple", async () => {
    const value = deliveryAttemptFixture();
    const derived = await nativeDeliveryAttemptId(value);

    expect(derived).toBe("nat_bEX3nvdt_IEjM13-PLEPAFKMzS0AHX2RH9pehZ6DSCw");
    await expect(
      verifyNativeDeliveryAttemptId(
        parseNativeDeliveryAttemptRecord({
          ...value,
          nativeDeliveryAttemptId: derived,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyNativeDeliveryAttemptId(parseNativeDeliveryAttemptRecord(value)),
    ).rejects.toThrow(/does not match/);
    expect(
      await nativeDeliveryAttemptId({
        ...value,
        nativeIncarnation: 1,
      }),
    ).not.toBe(derived);
  });

  it("pins the exact OpenCode user_text action, expected-part, and read-back contract", () => {
    const value = deliveryAttemptFixture();
    const invalidCases = [
      {
        name: "missing caller action ID",
        overrides: { nativeActionId: null },
        error: /caller-allocated msg_/,
      },
      {
        name: "wrong action-ID namespace",
        overrides: { nativeActionId: "action-1" },
        error: /caller-allocated msg_/,
      },
      {
        name: "wrong action-ID byte length",
        overrides: { nativeActionId: "msg_AA" },
        error: /exactly 16 bytes/,
      },
      {
        name: "wrong expected part count",
        overrides: { expectedNativePartCount: 2 },
        error: /must equal 1 for OpenCode user_text/,
      },
      {
        name: "wrong expected-part schema",
        overrides: {
          expectedNativePartFingerprintSchemaId: "remote-claw/native-part-fingerprint/v1",
        },
        error: /opencode-expected-user-part-vector\/v1/,
      },
      {
        name: "wrong positive read-back schema",
        overrides: { positiveReadBackSchemaId: "remote-claw/opencode-readback/v1" },
        error: /opencode-user-text-read-back\/v1/,
      },
    ] as const;

    for (const { name, overrides, error } of invalidCases) {
      expect(() => parseNativeDeliveryAttemptRecord({ ...value, ...overrides }), name).toThrow(
        error,
      );
    }
  });

  it("requires an atomic expected-part tuple and permits its absence for other mutations", () => {
    const value = deliveryAttemptFixture();
    const partialTuples = [
      { expectedNativePartFingerprintVectorDigest: null },
      {
        expectedNativePartCount: null,
        expectedNativePartFingerprintSchemaId: value.expectedNativePartFingerprintSchemaId,
        expectedNativePartFingerprintVectorRef: null,
        expectedNativePartFingerprintVectorDigest: null,
      },
      {
        expectedNativePartCount: null,
        expectedNativePartFingerprintSchemaId: null,
        expectedNativePartFingerprintVectorRef: value.expectedNativePartFingerprintVectorRef,
        expectedNativePartFingerprintVectorDigest: null,
      },
      {
        expectedNativePartCount: null,
        expectedNativePartFingerprintSchemaId: null,
        expectedNativePartFingerprintVectorRef: null,
        expectedNativePartFingerprintVectorDigest: value.expectedNativePartFingerprintVectorDigest,
      },
      {
        expectedNativePartCount: null,
        expectedNativePartFingerprintSchemaId: value.expectedNativePartFingerprintSchemaId,
        expectedNativePartFingerprintVectorRef: value.expectedNativePartFingerprintVectorRef,
        expectedNativePartFingerprintVectorDigest: null,
      },
      {
        expectedNativePartCount: null,
        expectedNativePartFingerprintSchemaId: value.expectedNativePartFingerprintSchemaId,
        expectedNativePartFingerprintVectorRef: null,
        expectedNativePartFingerprintVectorDigest: value.expectedNativePartFingerprintVectorDigest,
      },
      {
        expectedNativePartCount: null,
        expectedNativePartFingerprintSchemaId: null,
        expectedNativePartFingerprintVectorRef: value.expectedNativePartFingerprintVectorRef,
        expectedNativePartFingerprintVectorDigest: value.expectedNativePartFingerprintVectorDigest,
      },
    ] as const;
    for (const partialTuple of partialTuples) {
      expect(() =>
        parseNativeDeliveryAttemptRecord({
          ...value,
          ...partialTuple,
        }),
      ).toThrow(/count, schema, vector reference, and vector digest/);
    }

    const withoutExpectedParts = {
      ...value,
      mutationFamily: "interrupt",
      expectedNativePartCount: null,
      expectedNativePartFingerprintSchemaId: null,
      expectedNativePartFingerprintVectorRef: null,
      expectedNativePartFingerprintVectorDigest: null,
    } as const;
    expect(parseNativeDeliveryAttemptRecord(withoutExpectedParts)).toEqual(withoutExpectedParts);
  });

  it("requires read-back pairs and outcome-evidence triples atomically", () => {
    const value = deliveryAttemptFixture();
    expect(() =>
      parseNativeDeliveryAttemptRecord({
        ...value,
        nativeReadBackEvidenceRef: "readback-1",
      }),
    ).toThrow(/reference and digest/);
    expect(() =>
      parseNativeDeliveryAttemptRecord({
        ...value,
        outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
      }),
    ).toThrow(/all null or all present/);
  });

  it("accepts the selected delivery state and evidence matrix", () => {
    const value = deliveryAttemptFixture();
    const readBackEvidence = {
      nativeReadBackEvidenceRef: "readback-1",
      nativeReadBackEvidenceDigest: digest(30),
    };
    const outcomeEvidence = {
      outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
      outcomeEvidenceRef: "outcome-1",
      outcomeEvidenceDigest: digest(31),
    };
    const validCases = [
      { name: "prepared", overrides: {} },
      {
        name: "claimed",
        overrides: { state: "claimed", claimedByCoordinatorEpoch: 3 },
      },
      {
        name: "started",
        overrides: { state: "started", claimedByCoordinatorEpoch: 3 },
      },
      {
        name: "transport receipt",
        overrides: {
          state: "transport_receipt",
          claimedByCoordinatorEpoch: 3,
          transportReceiptRef: "transport-receipt-1",
        },
      },
      {
        name: "native observed directly from started",
        overrides: {
          state: "native_observed",
          claimedByCoordinatorEpoch: 3,
          ...readBackEvidence,
        },
      },
      {
        name: "completed directly from started",
        overrides: {
          state: "completed",
          claimedByCoordinatorEpoch: 3,
          ...readBackEvidence,
        },
      },
      {
        name: "rejected directly after start",
        overrides: {
          state: "rejected",
          claimedByCoordinatorEpoch: 3,
          ...outcomeEvidence,
        },
      },
      {
        name: "rejected after a transport receipt",
        overrides: {
          state: "rejected",
          claimedByCoordinatorEpoch: 3,
          transportReceiptRef: "transport-receipt-1",
          ...outcomeEvidence,
        },
      },
      {
        name: "quarantined before native start",
        overrides: { state: "quarantined", ...outcomeEvidence },
      },
      {
        name: "outcome unknown",
        overrides: {
          state: "outcome_unknown",
          claimedByCoordinatorEpoch: 3,
          ...outcomeEvidence,
        },
      },
    ] as const;

    for (const { name, overrides } of validCases) {
      expect(
        () => parseNativeDeliveryAttemptRecord({ ...value, ...overrides }),
        name,
      ).not.toThrow();
    }
  });

  it("rejects invalid delivery state and evidence combinations", () => {
    const value = deliveryAttemptFixture();
    const readBackEvidence = {
      nativeReadBackEvidenceRef: "readback-1",
      nativeReadBackEvidenceDigest: digest(30),
    };
    const outcomeEvidence = {
      outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
      outcomeEvidenceRef: "outcome-1",
      outcomeEvidenceDigest: digest(31),
    };
    const invalidCases = [
      {
        name: "prepared with a claiming epoch",
        overrides: { claimedByCoordinatorEpoch: 3 },
        error: /prepared rows cannot contain delivery evidence/,
      },
      {
        name: "prepared with a transport receipt",
        overrides: { transportReceiptRef: "transport-receipt-1" },
        error: /prepared rows cannot contain delivery evidence/,
      },
      {
        name: "prepared with read-back",
        overrides: readBackEvidence,
        error: /prepared rows cannot contain delivery evidence/,
      },
      {
        name: "prepared with outcome evidence",
        overrides: outcomeEvidence,
        error: /prepared rows cannot contain delivery evidence/,
      },
      {
        name: "claimed without an epoch",
        overrides: { state: "claimed" },
        error: /claimed rows require their epoch/,
      },
      {
        name: "claimed with delivery evidence",
        overrides: {
          state: "claimed",
          claimedByCoordinatorEpoch: 3,
          transportReceiptRef: "transport-receipt-1",
        },
        error: /cannot contain delivery evidence/,
      },
      {
        name: "started without an epoch",
        overrides: { state: "started" },
        error: /must identify the claiming epoch/,
      },
      {
        name: "started with later delivery evidence",
        overrides: {
          state: "started",
          claimedByCoordinatorEpoch: 3,
          transportReceiptRef: "transport-receipt-1",
        },
        error: /started rows cannot contain later delivery evidence/,
      },
      {
        name: "transport-receipt state without a receipt",
        overrides: { state: "transport_receipt", claimedByCoordinatorEpoch: 3 },
        error: /must be present once a transport receipt is recorded/,
      },
      {
        name: "transport-receipt state with later read-back",
        overrides: {
          state: "transport_receipt",
          claimedByCoordinatorEpoch: 3,
          transportReceiptRef: "transport-receipt-1",
          ...readBackEvidence,
        },
        error: /cannot contain later read-back or outcome evidence/,
      },
      {
        name: "native-observed state without read-back",
        overrides: { state: "native_observed", claimedByCoordinatorEpoch: 3 },
        error: /must be present once native application is observed/,
      },
      {
        name: "completed state without read-back",
        overrides: { state: "completed", claimedByCoordinatorEpoch: 3 },
        error: /must be present once native application is observed/,
      },
      {
        name: "completed state with negative outcome evidence",
        overrides: {
          state: "completed",
          claimedByCoordinatorEpoch: 3,
          ...readBackEvidence,
          ...outcomeEvidence,
        },
        error: /must be null for a positive native observation/,
      },
      {
        name: "rejected state without a claiming epoch",
        overrides: { state: "rejected", ...outcomeEvidence },
        error: /must identify the claiming epoch/,
      },
      {
        name: "rejected state without outcome evidence",
        overrides: { state: "rejected", claimedByCoordinatorEpoch: 3 },
        error: /must be present for a terminal negative or uncertain outcome/,
      },
      {
        name: "rejected state with positive native read-back",
        overrides: {
          state: "rejected",
          claimedByCoordinatorEpoch: 3,
          ...readBackEvidence,
          ...outcomeEvidence,
        },
        error: /must be null for a proved negative native outcome/,
      },
      {
        name: "quarantined state without outcome evidence",
        overrides: { state: "quarantined" },
        error: /must be present for a terminal negative or uncertain outcome/,
      },
      {
        name: "quarantined state with a transport receipt",
        overrides: {
          state: "quarantined",
          transportReceiptRef: "transport-receipt-1",
          ...outcomeEvidence,
        },
        error: /cannot contain transport or native read-back evidence/,
      },
      {
        name: "quarantined state with native read-back",
        overrides: { state: "quarantined", ...readBackEvidence, ...outcomeEvidence },
        error: /cannot contain transport or native read-back evidence/,
      },
      {
        name: "outcome-unknown state without an epoch",
        overrides: { state: "outcome_unknown", ...outcomeEvidence },
        error: /must identify the claiming epoch/,
      },
      {
        name: "outcome-unknown state without outcome evidence",
        overrides: { state: "outcome_unknown", claimedByCoordinatorEpoch: 3 },
        error: /must be present for a terminal negative or uncertain outcome/,
      },
    ] as const;

    for (const { name, overrides, error } of invalidCases) {
      expect(() => parseNativeDeliveryAttemptRecord({ ...value, ...overrides }), name).toThrow(
        error,
      );
    }
  });

  it("rejects unselected mutation families, schema versions, and extra fields", () => {
    const value = deliveryAttemptFixture();
    expect(() =>
      parseNativeDeliveryAttemptRecord({ ...value, mutationFamily: "shell_passthrough" }),
    ).toThrow(/not a selected value/);
    expect(() =>
      parseNativeDeliveryAttemptRecord({
        ...value,
        nativeRequestTranslationSchemaId: "remote-claw/native-request-translation/v2",
      }),
    ).toThrow(/nativeRequestTranslationSchemaId/);
    expect(() => parseNativeDeliveryAttemptRecord({ ...value, retryMayResend: true })).toThrow(
      /exactly the selected fields/,
    );
  });

  it("accepts the selected effect-gate state and evidence matrix", () => {
    const neverStarted = effectGateFixture();
    const outcomeEvidence = {
      outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
      outcomeEvidenceRef: "outcome-1",
      outcomeEvidenceDigest: digest(32),
    };
    const validCases = [
      { name: "never started", overrides: {} },
      {
        name: "started",
        overrides: { state: "started", startedAttemptId: attemptId },
      },
      {
        name: "completed",
        overrides: { state: "completed", startedAttemptId: attemptId },
      },
      {
        name: "quarantined before native start",
        overrides: { state: "quarantined", ...outcomeEvidence },
      },
      {
        name: "outcome unknown",
        overrides: {
          state: "outcome_unknown",
          startedAttemptId: attemptId,
          ...outcomeEvidence,
        },
      },
    ] as const;

    for (const { name, overrides } of validCases) {
      expect(
        () => parseNativeCommandEffectGateRecord({ ...neverStarted, ...overrides }),
        name,
      ).not.toThrow();
    }
  });

  it("rejects invalid effect-gate state and evidence combinations", () => {
    const neverStarted = effectGateFixture();
    const outcomeEvidence = {
      outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
      outcomeEvidenceRef: "outcome-1",
      outcomeEvidenceDigest: digest(32),
    };
    const invalidCases = [
      {
        name: "never-started gate with an attempt",
        overrides: { startedAttemptId: attemptId },
        error: /must be null when native start never occurred/,
      },
      {
        name: "never-started gate with outcome evidence",
        overrides: outcomeEvidence,
        error: /must be null for ordinary progress states/,
      },
      {
        name: "started gate without an attempt",
        overrides: { state: "started" },
        error: /must identify the started attempt/,
      },
      {
        name: "started gate with outcome evidence",
        overrides: { state: "started", startedAttemptId: attemptId, ...outcomeEvidence },
        error: /must be null for ordinary progress states/,
      },
      {
        name: "completed gate without an attempt",
        overrides: { state: "completed" },
        error: /must identify the started attempt/,
      },
      {
        name: "completed gate with outcome evidence",
        overrides: { state: "completed", startedAttemptId: attemptId, ...outcomeEvidence },
        error: /must be null for ordinary progress states/,
      },
      {
        name: "quarantined gate with a started attempt",
        overrides: { state: "quarantined", startedAttemptId: attemptId, ...outcomeEvidence },
        error: /must be null when native start never occurred/,
      },
      {
        name: "quarantined gate without outcome evidence",
        overrides: { state: "quarantined" },
        error: /must be present for a quarantined or uncertain outcome/,
      },
      {
        name: "outcome-unknown gate without an attempt",
        overrides: { state: "outcome_unknown", ...outcomeEvidence },
        error: /must identify the started attempt/,
      },
      {
        name: "outcome-unknown gate without outcome evidence",
        overrides: { state: "outcome_unknown", startedAttemptId: attemptId },
        error: /must be present for a quarantined or uncertain outcome/,
      },
    ] as const;

    for (const { name, overrides, error } of invalidCases) {
      expect(
        () => parseNativeCommandEffectGateRecord({ ...neverStarted, ...overrides }),
        name,
      ).toThrow(error);
    }
  });

  it("requires effect-gate outcome-evidence triples atomically", () => {
    expect(() =>
      parseNativeCommandEffectGateRecord({
        ...effectGateFixture(),
        state: "started",
        startedAttemptId: attemptId,
        outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
        outcomeEvidenceRef: "outcome-1",
      }),
    ).toThrow(/all null or all present/);
  });
});

describe("native front-door dispatch records", () => {
  it("accepts and verifies an exact not-started dispatch", async () => {
    const value = await frontDoorFixture();
    const parsed = parseNativeFrontDoorDispatchRecord(value);

    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    await expect(verifyNativeFrontDoorDispatchDigest(parsed)).resolves.toBeUndefined();
    expect(value.canonicalDispatchDigest).toBe("5uDubcAvGIMdRS9_cY_jNTVZxWrWdDnHGpG2GJ8Zr_A");
    await expect(
      verifyNativeFrontDoorDispatchDigest({
        ...value,
        canonicalDispatchDigest: noncanonicalTailAlias(value.canonicalDispatchDigest),
      } as unknown as Parameters<typeof verifyNativeFrontDoorDispatchDigest>[0]),
    ).rejects.toThrow(/canonical/);
  });

  it("commits every dispatch identity, target, translation, and authorization field", async () => {
    const value = await frontDoorFixture();
    const baseline = await nativeFrontDoorDispatchDigest(value);
    const changedRecords = [
      { ...value, nativeDeliveryAttemptId: otherAttemptId },
      { ...value, nativeClientIngressLeaseId: parseA1SafeId("ingress-lease-2") },
      { ...value, nativeTargetPathDigest: digest(32) },
      { ...value, canonicalRequestDigest: digest(33) },
      { ...value, nativeRequestTranslationDigest: digest(34) },
      {
        ...value,
        dispatchAuthorizationRef: {
          ...value.dispatchAuthorizationRef,
          protectedHandleId: parseA1CanonicalId("protectedHandle", `rcph_${encoded(16, 35)}`),
        },
      },
    ];
    for (const changed of changedRecords) {
      expect(await nativeFrontDoorDispatchDigest(changed)).not.toBe(baseline);
    }
    for (const malformed of [
      noncanonicalTailAlias(value.nativeTargetPathDigest),
      "A".repeat(1_000_000),
    ]) {
      await expect(
        nativeFrontDoorDispatchDigest({
          ...value,
          nativeTargetPathDigest: malformed,
        } as unknown as Parameters<typeof nativeFrontDoorDispatchDigest>[0]),
      ).rejects.toThrow(/canonical|exactly 32 bytes/);
    }

    const rowMetadataChanged = {
      ...value,
      dispatchState: "completed",
      dispatchStartedAtMs: 500,
      nativeReceiptRef: "receipt-1",
    } as const;
    expect(await nativeFrontDoorDispatchDigest(rowMetadataChanged)).toBe(baseline);
    await expect(
      verifyNativeFrontDoorDispatchDigest(
        parseNativeFrontDoorDispatchRecord({
          ...value,
          canonicalDispatchDigest: digest(36),
        }),
      ),
    ).rejects.toThrow(/does not match/);
    expect(() =>
      parseNativeFrontDoorDispatchRecord({
        ...value,
        dispatchAuthorizationRef: {
          ...value.dispatchAuthorizationRef,
          kind: "artifact",
        },
      }),
    ).toThrow(/dispatchAuthorizationRef.kind/);
  });

  it("requires front-door outcome-evidence triples atomically", async () => {
    const value = await frontDoorFixture();
    expect(() =>
      parseNativeFrontDoorDispatchRecord({
        ...value,
        outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
      }),
    ).toThrow(/all null or all present/);
  });

  it("accepts the selected front-door state and evidence matrix", async () => {
    const value = await frontDoorFixture();
    const outcomeEvidence = {
      outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
      outcomeEvidenceRef: "outcome-1",
      outcomeEvidenceDigest: digest(37),
    };
    const validCases = [
      { name: "not started", overrides: {} },
      {
        name: "started",
        overrides: { dispatchState: "started", dispatchStartedAtMs: 500 },
      },
      {
        name: "completed",
        overrides: {
          dispatchState: "completed",
          dispatchStartedAtMs: 500,
          nativeReceiptRef: "receipt-1",
        },
      },
      {
        name: "quarantined before native start",
        overrides: { dispatchState: "quarantined", ...outcomeEvidence },
      },
      {
        name: "outcome unknown",
        overrides: {
          dispatchState: "outcome_unknown",
          dispatchStartedAtMs: 500,
          ...outcomeEvidence,
        },
      },
    ] as const;

    for (const { name, overrides } of validCases) {
      expect(
        () => parseNativeFrontDoorDispatchRecord({ ...value, ...overrides }),
        name,
      ).not.toThrow();
    }
  });

  it("rejects invalid front-door state and evidence combinations", async () => {
    const value = await frontDoorFixture();
    const outcomeEvidence = {
      outcomeEvidenceSchemaId: "remote-claw/outcome/v1",
      outcomeEvidenceRef: "outcome-1",
      outcomeEvidenceDigest: digest(37),
    };
    const invalidCases = [
      {
        name: "not-started dispatch with a start time",
        overrides: { dispatchStartedAtMs: 1 },
        error: /must be null before dispatch/,
      },
      {
        name: "not-started dispatch with a receipt",
        overrides: { nativeReceiptRef: "receipt-1" },
        error: /cannot contain native or outcome evidence/,
      },
      {
        name: "not-started dispatch with outcome evidence",
        overrides: outcomeEvidence,
        error: /cannot contain native or outcome evidence/,
      },
      {
        name: "started dispatch without a start time",
        overrides: { dispatchState: "started" },
        error: /must be present after dispatch starts/,
      },
      {
        name: "started dispatch with outcome evidence",
        overrides: {
          dispatchState: "started",
          dispatchStartedAtMs: 500,
          ...outcomeEvidence,
        },
        error: /must be null for a positive dispatch state/,
      },
      {
        name: "started dispatch with a receipt",
        overrides: {
          dispatchState: "started",
          dispatchStartedAtMs: 500,
          nativeReceiptRef: "receipt-1",
        },
        error: /must be null until dispatch is completed/,
      },
      {
        name: "completed dispatch without a start time",
        overrides: { dispatchState: "completed", nativeReceiptRef: "receipt-1" },
        error: /must be present after dispatch starts/,
      },
      {
        name: "completed dispatch without a receipt",
        overrides: { dispatchState: "completed", dispatchStartedAtMs: 500 },
        error: /must be present when dispatch is completed/,
      },
      {
        name: "completed dispatch with outcome evidence",
        overrides: {
          dispatchState: "completed",
          dispatchStartedAtMs: 500,
          nativeReceiptRef: "receipt-1",
          ...outcomeEvidence,
        },
        error: /must be null for a positive dispatch state/,
      },
      {
        name: "quarantined dispatch without outcome evidence",
        overrides: { dispatchState: "quarantined" },
        error: /must be present for a quarantined or uncertain outcome/,
      },
      {
        name: "quarantined dispatch with a start time",
        overrides: {
          dispatchState: "quarantined",
          dispatchStartedAtMs: 500,
          ...outcomeEvidence,
        },
        error: /must be null when dispatch was quarantined before start/,
      },
      {
        name: "quarantined dispatch with a receipt",
        overrides: {
          dispatchState: "quarantined",
          nativeReceiptRef: "receipt-1",
          ...outcomeEvidence,
        },
        error: /must be null when dispatch was quarantined before start/,
      },
      {
        name: "outcome-unknown dispatch without a start time",
        overrides: { dispatchState: "outcome_unknown", ...outcomeEvidence },
        error: /must be present after dispatch starts/,
      },
      {
        name: "outcome-unknown dispatch without outcome evidence",
        overrides: { dispatchState: "outcome_unknown", dispatchStartedAtMs: 500 },
        error: /must be present for a quarantined or uncertain outcome/,
      },
    ] as const;

    for (const { name, overrides, error } of invalidCases) {
      expect(() => parseNativeFrontDoorDispatchRecord({ ...value, ...overrides }), name).toThrow(
        error,
      );
    }
  });
});
