import { describe, expect, it } from "vitest";
import {
  A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_ATTACHMENT_ITEM_SCHEMA_ID,
  A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
  A1_COMMAND_DECISION_POLICY_ID,
  A1_COMMAND_MAX_ATTACHMENT_CAPTION_BYTES,
  A1_COMMAND_MAX_ATTACHMENT_FILENAME_BYTES,
  A1_COMMAND_MAX_ATTACHMENT_ITEM_BYTES,
  A1_COMMAND_MAX_ATTACHMENT_ITEMS,
  A1_COMMAND_MAX_ATTACHMENT_TOTAL_BYTES,
  A1_COMMAND_MAX_USER_TEXT_BYTES,
  A1_COMMAND_RESULT_SCHEMA_ID,
  A1_NATIVE_BINDING_EXECUTOR_EVIDENCE_SCHEMA_ID,
  A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_SIGNED_COMMAND_RESULT_DOMAIN,
  A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID,
  type A1CanonicalAttachmentItemRecord,
  type A1CanonicalCommandRecord,
  type A1CanonicalCommandResultPayload,
  A1CommandContractError,
  type A1CommandDecisionEvidence,
  type A1CommandPayload,
  type A1CommandSource,
  a1AttachmentItemVectorDigest,
  a1CanonicalAttachmentItemDigest,
  a1CanonicalCommandRecordDigest,
  a1CanonicalCommandResultPayloadDigest,
  a1CommandDecisionEvidenceDigest,
  a1CommandPayloadDigest,
  a1SignedCommandResultDigest,
  a1SourceCommandIdentityDigest,
  assertA1AttachmentCommandPayloadManifest,
  assertA1CanonicalCommandId,
  assertA1CommandPayloadBinding,
  assertA1CommandResultId,
  canonicalA1AttachmentItem,
  canonicalA1CollaborationCommandIdPreimage,
  canonicalA1CommandDecisionEvidence,
  canonicalA1CommandPayload,
  canonicalA1CommandRecord,
  canonicalA1CommandResultIdPreimage,
  canonicalA1CommandResultPayload,
  canonicalA1CommandResultPreparationIdPreimage,
  canonicalA1CommandSigningGroupIdPreimage,
  canonicalA1CommandSourceIdentity,
  canonicalA1SignedCommandResult,
  deriveA1CollaborationCommandId,
  deriveA1CommandResultId,
  deriveA1CommandResultPreparationId,
  deriveA1CommandSigningGroupId,
  parseA1CanonicalAttachmentItemRecord,
  parseA1CanonicalCommandRecord,
  parseA1CanonicalCommandResultPayload,
  parseA1CommandDecisionEvidence,
  parseA1CommandPayload,
  parseA1CommandSource,
  parseA1SignedCommandResultInput,
} from "./a1-command.js";
import { base64urlDecode, base64urlEncode } from "./base64url.js";

function bytes(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

const IDENTITY_ID = bytes(16, 0x00);
const SERVER_ID = `rcs_${base64urlEncode(bytes(16, 0x10))}`;
const CHAT_ID = `rcl_${base64urlEncode(bytes(16, 0x20))}`;
const TARGET_CHAT_ID = `rcl_${base64urlEncode(bytes(16, 0x30))}`;
const NAMESPACE_ID = `wns_${base64urlEncode(bytes(32, 0x40))}`;
const SOURCE_REF = `rrs_${base64urlEncode(bytes(32, 0x60))}`;
const DIGEST_A = base64urlEncode(bytes(32, 0x80));
const DIGEST_B = base64urlEncode(bytes(32, 0xa0));
const DIGEST_C = base64urlEncode(bytes(32, 0xc0));
const SIGNATURE = base64urlEncode(bytes(64, 0x40));

function userTextPayload(text = "hello\n世界"): A1CommandPayload {
  return {
    schemaVersion: 1,
    canonicalCommandPayloadSchemaId: A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID,
    text,
  };
}

function newChatPayload(): A1CommandPayload {
  return {
    schemaVersion: 1,
    canonicalCommandPayloadSchemaId: A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID,
    creationIntent: "new_chat",
    projectId: "project.alpha",
    workspaceSelectorId: "workspace:main",
  };
}

function unsupportedPayload(): A1CommandPayload {
  return {
    schemaVersion: 1,
    canonicalCommandPayloadSchemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
    normalizedMutationFamily: "compact",
    sourcePayloadSchemaId: "remote-claw/a1-ingress-user/v1",
    sourcePayloadDigest: DIGEST_A,
    sourceEventFingerprint: DIGEST_B,
  };
}

function ingressSource(): A1CommandSource {
  return {
    sourceKind: "a1_ingress",
    identityId: IDENTITY_ID,
    collaborationServerId: SERVER_ID,
    scopeKind: "chat",
    logicalChatId: CHAT_ID,
    sourceEventNamespaceId: NAMESPACE_ID,
    sourceEventId: "web.msg-1",
  };
}

async function attachmentItem(
  itemIndex: number,
  overrides: Partial<A1CanonicalAttachmentItemRecord> = {},
): Promise<A1CanonicalAttachmentItemRecord> {
  const input: A1CanonicalAttachmentItemRecord = {
    schemaVersion: 1,
    canonicalItemSchemaId: A1_ATTACHMENT_ITEM_SCHEMA_ID,
    itemIndex,
    clientFileName: `image-${itemIndex}.png`,
    mediaType: "image/png",
    contentLength: 100 + itemIndex,
    contentRef: `artifact:${itemIndex}`,
    contentDigest: itemIndex === 0 ? DIGEST_A : DIGEST_B,
    canonicalItemDigest: DIGEST_C,
    ...overrides,
  };
  return {
    ...input,
    canonicalItemDigest: await a1CanonicalAttachmentItemDigest(input),
  };
}

async function rejectedDecisionEvidence(commandId: string): Promise<A1CommandDecisionEvidence> {
  return {
    schemaVersion: 1,
    decisionEvidenceSchemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    commandId,
    collaborationServerId: SERVER_ID,
    scopeKind: "chat",
    projectTargetSelectorMappingId: null,
    projectTargetSelectorMappingGeneration: null,
    projectTargetDigest: null,
    selectedTargetKind: null,
    selectedExecutorEvidenceSchemaId: null,
    selectedExecutorEvidenceRef: null,
    selectedExecutorEvidenceDigest: null,
    targetCapabilitySnapshotId: null,
    targetCapabilityFamilyDigest: null,
    decisionPolicyId: A1_COMMAND_DECISION_POLICY_ID,
  };
}

async function rejectedCommandRecord(): Promise<A1CanonicalCommandRecord> {
  const source = ingressSource();
  const sourceCommandIdentityDigest = await a1SourceCommandIdentityDigest(source);
  const commandId = await deriveA1CollaborationCommandId({
    collaborationServerId: SERVER_ID,
    sourceKind: "a1_ingress",
    sourceCommandIdentityDigest,
  });
  const decision = await rejectedDecisionEvidence(commandId);
  return {
    commandId,
    collaborationServerId: SERVER_ID,
    scopeKind: "chat",
    logicalChatId: CHAT_ID,
    targetLogicalChatId: CHAT_ID,
    sourceKind: "a1_ingress",
    sourceRef: SOURCE_REF,
    sourceEventNamespaceId: NAMESPACE_ID,
    sourceEventId: "web.msg-1",
    sourceCommandIdentityDigest,
    canonicalSourceEventDigest: null,
    mutationFamily: "user_text",
    canonicalCommandPayloadSchemaId: A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID,
    canonicalCommandPayloadDigest: await a1CommandPayloadDigest(userTextPayload()),
    preDecisionNormalizationEvidenceSchemaId: null,
    preDecisionNormalizationEvidenceDigest: null,
    readyAtJournalSeq: 17,
    commandSeq: 3,
    disposition: "rejected",
    admittedTargetKind: null,
    targetCapabilitySnapshotId: null,
    targetCapabilityFamilyDigest: null,
    decisionEvidenceSchemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    decisionEvidenceDigest: await a1CommandDecisionEvidenceDigest(decision),
  };
}

async function rejectedResultPayload(): Promise<A1CanonicalCommandResultPayload> {
  const command = await rejectedCommandRecord();
  return {
    canonicalPayloadSchemaId: A1_COMMAND_RESULT_SCHEMA_ID,
    commandResultId: await deriveA1CommandResultId({
      collaborationServerId: command.collaborationServerId,
      commandId: command.commandId,
    }),
    collaborationServerId: command.collaborationServerId,
    commandId: command.commandId,
    canonicalCommandRecordDigest: await a1CanonicalCommandRecordDigest(command),
    resultVersion: 1,
    supersedesCommandResultId: null,
    sourceKind: command.sourceKind,
    sourceRef: command.sourceRef,
    scopeKind: command.scopeKind,
    logicalChatId: command.logicalChatId,
    targetLogicalChatId: command.targetLogicalChatId,
    commandSeq: command.commandSeq,
    disposition: command.disposition,
    createdAtMs: 1_725_000_000_123,
    signerSequence: 9,
    serverKeyGeneration: 1,
    signerIdentityKeyId: "server-key:1",
    signerScopeCertificateId: "scope-cert:1",
    signatureAlgorithm: "Ed25519",
  };
}

function nonCanonicalTailAlias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(value.at(-1) as string);
  for (let candidate = 0; candidate < alphabet.length; candidate++) {
    const alias = `${value.slice(0, -1)}${alphabet[candidate]}`;
    if (
      candidate !== last &&
      base64urlDecode(alias).every((byte, i) => byte === base64urlDecode(value)[i])
    ) {
      return alias;
    }
  }
  throw new Error("fixture has no base64url tail alias");
}

describe("A1.7b1 common command payload contract", () => {
  it("locks selected payload and attachment bounds", () => {
    expect({
      userTextBytes: A1_COMMAND_MAX_USER_TEXT_BYTES,
      attachmentItems: A1_COMMAND_MAX_ATTACHMENT_ITEMS,
      attachmentItemBytes: A1_COMMAND_MAX_ATTACHMENT_ITEM_BYTES,
      attachmentTotalBytes: A1_COMMAND_MAX_ATTACHMENT_TOTAL_BYTES,
      attachmentFileNameBytes: A1_COMMAND_MAX_ATTACHMENT_FILENAME_BYTES,
      attachmentCaptionBytes: A1_COMMAND_MAX_ATTACHMENT_CAPTION_BYTES,
    }).toEqual({
      userTextBytes: 50_331_648,
      attachmentItems: 24,
      attachmentItemBytes: 12_582_912,
      attachmentTotalBytes: 37_748_736,
      attachmentFileNameBytes: 255,
      attachmentCaptionBytes: 16_384,
    });
  });

  it("encodes all four payload arms byte-exactly and preserves text scalars", async () => {
    const values = [userTextPayload(), newChatPayload(), unsupportedPayload()];
    for (const value of values) {
      expect(parseA1CommandPayload(value)).toEqual(value);
      expect(canonicalA1CommandPayload(value)).toBeInstanceOf(Uint8Array);
      expect(await a1CommandPayloadDigest(value)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(await a1CommandPayloadDigest(userTextPayload("e\u0301"))).not.toBe(
      await a1CommandPayloadDigest(userTextPayload("é")),
    );
    expect(() => parseA1CommandPayload(userTextPayload("\ud800"))).toThrow(/Unicode scalar/);
  });

  it("recomputes contiguous attachment item and vector digests", async () => {
    const items = [await attachmentItem(0), await attachmentItem(1)];
    const itemVectorDigest = await a1AttachmentItemVectorDigest(items);
    const payload = {
      schemaVersion: 1,
      canonicalCommandPayloadSchemaId: A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID,
      caption: null,
      itemVectorRef: "manifest:one",
      itemCount: items.length,
      itemVectorDigest,
    } as const;
    expect(parseA1CanonicalAttachmentItemRecord(items[0])).toEqual(items[0]);
    expect(canonicalA1AttachmentItem(items[0])).toBeInstanceOf(Uint8Array);
    await expect(assertA1AttachmentCommandPayloadManifest(payload, items)).resolves.toBeUndefined();
    expect(await a1CommandPayloadDigest(payload)).not.toBe(
      await a1CommandPayloadDigest({ ...payload, caption: "" }),
    );
    await expect(
      assertA1AttachmentCommandPayloadManifest({ ...payload, itemVectorDigest: DIGEST_A }, items),
    ).rejects.toThrow(/itemVectorDigest/);
    await expect(a1AttachmentItemVectorDigest([items[1], items[0]])).rejects.toThrow(/contiguous/);
  });

  it.each([
    "../x.png",
    "x/y.png",
    "x\\y.png",
    "x\u0000.png",
    "x\u0085.png",
  ])("rejects hostile attachment filename %j", async (clientFileName) => {
    await expect(attachmentItem(0, { clientFileName })).rejects.toThrow(A1CommandContractError);
  });

  it("rejects extra fields, accessors, prototypes, symbols, invalid schemas, and digest aliases", () => {
    expect(() => parseA1CommandPayload({ ...userTextPayload(), extra: true })).toThrow(
      A1CommandContractError,
    );
    const accessor = { ...userTextPayload() } as Record<string, unknown>;
    Object.defineProperty(accessor, "text", { get: () => "x", enumerable: true });
    expect(() => parseA1CommandPayload(accessor)).toThrow(/own data property/);
    expect(() => parseA1CommandPayload(Object.create(userTextPayload()))).toThrow(
      /plain object|own data property/,
    );
    expect(() => parseA1CommandPayload({ ...userTextPayload(), [Symbol("x")]: 1 })).toThrow(
      /exactly/,
    );
    expect(() =>
      parseA1CommandPayload({
        ...unsupportedPayload(),
        sourcePayloadSchemaId: "remote claw/bad schema",
      }),
    ).toThrow(/Schema|schema/);
    expect(() =>
      parseA1CommandPayload({
        ...unsupportedPayload(),
        sourcePayloadDigest: nonCanonicalTailAlias(DIGEST_A),
      }),
    ).toThrow(/canonical/);
  });
});

describe("A1.7b1 source, decision, and command record contract", () => {
  it("derives stable scoped source and command identities", async () => {
    const source = ingressSource();
    const sourceDigest = await a1SourceCommandIdentityDigest(source);
    const commandInput = {
      collaborationServerId: SERVER_ID,
      sourceKind: "a1_ingress",
      sourceCommandIdentityDigest: sourceDigest,
    } as const;
    expect(parseA1CommandSource(source)).toEqual(source);
    expect(canonicalA1CommandSourceIdentity(source)).toBeInstanceOf(Uint8Array);
    expect(canonicalA1CollaborationCommandIdPreimage(commandInput)).toBeInstanceOf(Uint8Array);
    expect(await deriveA1CollaborationCommandId(commandInput)).toMatch(/^rcm_[A-Za-z0-9_-]{43}$/);
    expect(
      await a1SourceCommandIdentityDigest({ ...source, logicalChatId: TARGET_CHAT_ID }),
    ).not.toBe(sourceDigest);
  });

  it("separates outside sources and rejects scope transplants", async () => {
    const outside: A1CommandSource = {
      sourceKind: "official_client",
      collaborationServerId: SERVER_ID,
      scopeKind: "chat",
      logicalChatId: CHAT_ID,
      outsideBindingId: "outside:one",
      sourceEventNamespaceId: "provider:epoch-1",
      sourceEventId: "provider:event-1",
      canonicalSourceEventDigest: DIGEST_A,
    };
    expect(parseA1CommandSource(outside)).toEqual(outside);
    expect(await a1SourceCommandIdentityDigest(outside)).not.toBe(
      await a1SourceCommandIdentityDigest(ingressSource()),
    );
    expect(() => parseA1CommandSource({ ...ingressSource(), scopeKind: "server_control" })).toThrow(
      /scope/,
    );
    expect(() =>
      parseA1CommandSource(
        new Proxy(ingressSource(), {
          ownKeys: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toThrow(A1CommandContractError);
  });

  it("encodes rejected and admitted decision evidence and rejects partial/mismatched arms", async () => {
    const command = await rejectedCommandRecord();
    const rejected = await rejectedDecisionEvidence(command.commandId);
    expect(parseA1CommandDecisionEvidence(rejected)).toEqual(rejected);
    expect(canonicalA1CommandDecisionEvidence(rejected)).toBeInstanceOf(Uint8Array);
    expect(await a1CommandDecisionEvidenceDigest(rejected)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const admitted: A1CommandDecisionEvidence = {
      ...rejected,
      selectedTargetKind: "native_binding",
      selectedExecutorEvidenceSchemaId: A1_NATIVE_BINDING_EXECUTOR_EVIDENCE_SCHEMA_ID,
      selectedExecutorEvidenceRef: "executor:evidence-1",
      selectedExecutorEvidenceDigest: DIGEST_A,
      targetCapabilitySnapshotId: "capability:1",
      targetCapabilityFamilyDigest: DIGEST_B,
    };
    expect(parseA1CommandDecisionEvidence(admitted)).toEqual(admitted);
    expect(() =>
      parseA1CommandDecisionEvidence({ ...admitted, selectedExecutorEvidenceDigest: null }),
    ).toThrow(/all null or all set/);
    expect(() =>
      parseA1CommandDecisionEvidence({
        ...admitted,
        selectedExecutorEvidenceSchemaId: "remote-claw/executor-evidence/native-server/v1",
      }),
    ).toThrow(/does not match/);
  });

  it("encodes the complete frozen command record and validates current-tree A1 source mapping", async () => {
    const command = await rejectedCommandRecord();
    expect(parseA1CanonicalCommandRecord(command)).toEqual(command);
    expect(canonicalA1CommandRecord(command)).toBeInstanceOf(Uint8Array);
    expect(await a1CanonicalCommandRecordDigest(command)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(assertA1CanonicalCommandId(command)).resolves.toBeUndefined();
    expect(() =>
      parseA1CanonicalCommandRecord({ ...command, sourceRef: "ingress:invented" }),
    ).toThrow(/rrs_/);
    expect(() =>
      parseA1CanonicalCommandRecord({ ...command, canonicalSourceEventDigest: DIGEST_A }),
    ).toThrow(/null exactly/);
    expect(() =>
      parseA1CanonicalCommandRecord({
        ...command,
        canonicalCommandPayloadSchemaId: A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID,
      }),
    ).toThrow(/mutation family/);
    await expect(
      assertA1CanonicalCommandId({ ...command, commandId: `rcm_${DIGEST_A}` }),
    ).rejects.toThrow(/does not recompute/);
  });

  it("permits a bounded unsupported-recognized envelope for server-control new_chat", async () => {
    const base = await rejectedCommandRecord();
    const payload = {
      ...unsupportedPayload(),
      normalizedMutationFamily: "new_chat" as const,
    };
    const command: A1CanonicalCommandRecord = {
      ...base,
      scopeKind: "server_control",
      logicalChatId: null,
      targetLogicalChatId: null,
      mutationFamily: "new_chat",
      canonicalCommandPayloadSchemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
      canonicalCommandPayloadDigest: await a1CommandPayloadDigest(payload),
    };
    expect(parseA1CanonicalCommandRecord(command)).toEqual(command);
    await expect(assertA1CommandPayloadBinding(command, payload)).resolves.toBeUndefined();
    await expect(assertA1CommandPayloadBinding(command, unsupportedPayload())).rejects.toThrow(
      /payload digest|mutation family/,
    );
  });
});

describe("A1.7b1 result and signing identities", () => {
  it("locks byte-exact cross-runtime command and result vectors", async () => {
    const user = userTextPayload();
    const source = ingressSource();
    const sourceDigest = await a1SourceCommandIdentityDigest(source);
    const command = await rejectedCommandRecord();
    const decision = await rejectedDecisionEvidence(command.commandId);
    const result = await rejectedResultPayload();
    const groupInput = {
      collaborationServerId: SERVER_ID,
      commandId: command.commandId,
      commandResultId: result.commandResultId,
      preparationGeneration: 1,
    };
    const signed = {
      canonicalPayloadDigest: await a1CanonicalCommandResultPayloadDigest(result),
      signerIdentityKeyId: result.signerIdentityKeyId,
      serverKeyGeneration: result.serverKeyGeneration,
      signerSequence: result.signerSequence,
      signature: SIGNATURE,
    };
    expect({
      userBytes: base64urlEncode(canonicalA1CommandPayload(user)),
      userDigest: await a1CommandPayloadDigest(user),
      sourceBytes: base64urlEncode(canonicalA1CommandSourceIdentity(source)),
      sourceDigest,
      commandId: command.commandId,
      decisionDigest: await a1CommandDecisionEvidenceDigest(decision),
      commandDigest: await a1CanonicalCommandRecordDigest(command),
      resultId: result.commandResultId,
      resultDigest: await a1CanonicalCommandResultPayloadDigest(result),
      groupId: await deriveA1CommandSigningGroupId(groupInput),
      preparationId: await deriveA1CommandResultPreparationId(groupInput),
      signedDigest: await a1SignedCommandResultDigest(signed),
    }).toEqual({
      userBytes:
        "AAAAKHJlbW90ZS1jbGF3L2NvbW1hbmQtcGF5bG9hZC91c2VyLXRleHQvdjEAAAAIAAAAAAAAAAEAAAAMaGVsbG8K5LiW55WM",
      userDigest: "jXSuOUCqSkYc0mJR0-nvFfQ3kX6OxvNQssLmmD333CY",
      sourceBytes:
        "AAAAIHJlbW90ZS1jbGF3L2NvbW1hbmQtc291cmNlL2ExL3YxAAAAEAABAgMEBQYHCAkKCwwNDg8AAAAacmNzX0VCRVNFeFFWRmhjWUdSb2JIQjBlSHcAAAAEY2hhdAEAAAAacmNsX0lDRWlJeVFsSmljb0tTb3JMQzB1THcAAAAvd25zX1FFRkNRMFJGUmtkSVNVcExURTFPVDFCUlVsTlVWVlpYV0ZsYVcxeGRYbDgAAAAJd2ViLm1zZy0x",
      sourceDigest: "fmQzvtmmjVw9dx8vqg8Yh2cnSj11NLTlRW8GRpsGknM",
      commandId: "rcm_1UHFdhEjYMjYmc1dSOO9j1UqGEnfe0D8jJ0R9QwZ2mI",
      decisionDigest: "Mh1_IE2UAsBRbyHM_Ir3tpzVlO2bBIzT3jEEAmNV5xU",
      commandDigest: "XbyHf21FPU1y6mHkh_IOstaTRistttx_VkGv-5xhsQs",
      resultId: "ccr_mry-vaiPjc87NV4xj3anCHiDEM9_J5q_kYwxPWLR5Qo",
      resultDigest: "7OMhbVWoMxXF919FcB_HFlJKkSHUxS7NweIlTQ0x4BQ",
      groupId: "csg_ZXEjnN107RVFASkb7zDwIOUwiHXC7W4oalStnoIYfkM",
      preparationId: "crp_bO2a70ttci7qMNEBnl50vph-3xkWL1QPQl1pDueAjdk",
      signedDigest: "bERTXeEnrLN64PNgB_nnAG5A15a-lWywIKevruXYYkg",
    });
  });

  it("derives result, compound-group, and preparation IDs with independent domains", async () => {
    const command = await rejectedCommandRecord();
    const commandResultId = await deriveA1CommandResultId({
      collaborationServerId: SERVER_ID,
      commandId: command.commandId,
    });
    const input = {
      collaborationServerId: SERVER_ID,
      commandId: command.commandId,
      commandResultId,
      preparationGeneration: 1,
    };
    expect(
      canonicalA1CommandResultIdPreimage({
        collaborationServerId: input.collaborationServerId,
        commandId: input.commandId,
      }),
    ).toBeInstanceOf(Uint8Array);
    expect(canonicalA1CommandSigningGroupIdPreimage(input)).toBeInstanceOf(Uint8Array);
    expect(canonicalA1CommandResultPreparationIdPreimage(input)).toBeInstanceOf(Uint8Array);
    expect(commandResultId).toMatch(/^ccr_[A-Za-z0-9_-]{43}$/);
    expect(await deriveA1CommandSigningGroupId(input)).toMatch(/^csg_[A-Za-z0-9_-]{43}$/);
    expect(await deriveA1CommandResultPreparationId(input)).toMatch(/^crp_[A-Za-z0-9_-]{43}$/);
    expect(await deriveA1CommandSigningGroupId(input)).not.toBe(
      await deriveA1CommandResultPreparationId(input),
    );
  });

  it("encodes a stable rejected result and its signed-record digest", async () => {
    const result = await rejectedResultPayload();
    expect(parseA1CanonicalCommandResultPayload(result)).toEqual(result);
    expect(canonicalA1CommandResultPayload(result)).toBeInstanceOf(Uint8Array);
    expect(await a1CanonicalCommandResultPayloadDigest(result)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(assertA1CommandResultId(result)).resolves.toBeUndefined();

    const signed = {
      canonicalPayloadDigest: await a1CanonicalCommandResultPayloadDigest(result),
      signerIdentityKeyId: result.signerIdentityKeyId,
      serverKeyGeneration: result.serverKeyGeneration,
      signerSequence: result.signerSequence,
      signature: SIGNATURE,
    };
    expect(parseA1SignedCommandResultInput(signed)).toEqual(signed);
    expect(canonicalA1SignedCommandResult(signed)).toBeInstanceOf(Uint8Array);
    expect(await a1SignedCommandResultDigest(signed)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new TextDecoder().decode(canonicalA1SignedCommandResult(signed))).toContain(
      A1_SIGNED_COMMAND_RESULT_DOMAIN,
    );
  });

  it("rejects invalid result scope, supersession, ID, and signature encodings", async () => {
    const result = await rejectedResultPayload();
    expect(() =>
      parseA1CanonicalCommandResultPayload({
        ...result,
        supersedesCommandResultId: result.commandResultId,
      }),
    ).toThrow(/must be null/);
    expect(() =>
      parseA1CanonicalCommandResultPayload({ ...result, scopeKind: "server_control" }),
    ).toThrow(/scope/);
    await expect(
      assertA1CommandResultId({ ...result, commandResultId: `ccr_${DIGEST_A}` }),
    ).rejects.toThrow(/does not recompute/);
    expect(() =>
      parseA1SignedCommandResultInput({
        canonicalPayloadDigest: DIGEST_A,
        signerIdentityKeyId: "key:1",
        serverKeyGeneration: 1,
        signerSequence: 1,
        signature: DIGEST_B,
      }),
    ).toThrow(/64 bytes/);
  });
});
