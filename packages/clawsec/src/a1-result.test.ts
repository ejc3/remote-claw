import { describe, expect, it } from "vitest";
import type { BrokerChannelCursorV1 } from "./a1-broker.js";
import {
  A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID,
  A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
  A1_PROJECTION_ACCEPTED_PAYLOAD_SCHEMA_ID,
  A1_RESULT_DELIVERY_ID_DOMAIN,
  A1_STORED_SEMANTIC_RESULT_DOMAIN,
  A1ResultContractError,
  a1StoredSemanticResultDigest,
  canonicalA1ResultDeliveryIdPreimage,
  canonicalA1StoredSemanticResultPreimage,
  deriveA1ResultDeliveryId,
  encodeA1AdmittedChatCreationResultPayloadV1,
  encodeA1AdmittedChatCreationResultPayloadV1Bytes,
  encodeA1ProjectionAcceptedPayloadV1,
  encodeA1ProjectionAcceptedPayloadV1Bytes,
  encodeA1RejectedActionResultPayloadV1,
  encodeA1RejectedActionResultPayloadV1Bytes,
  encodeA1RejectedChatCreationResultPayloadV1,
  encodeA1RejectedChatCreationResultPayloadV1Bytes,
  parseA1AdmittedChatCreationResultPayloadV1,
  parseA1IngressResultIdentity,
  parseA1ProjectionAcceptedPayloadV1,
  parseA1RejectedActionResultPayloadV1,
  parseA1RejectedChatCreationResultPayloadV1,
  selectA1CompletionObservation,
} from "./a1-result.js";
import { base64urlEncode } from "./base64url.js";
import { CanonicalWriter } from "./canonical.js";

function bytes(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

const RESULT_ID = `rrs_${base64urlEncode(bytes(32, 0x00))}`;
const OTHER_RESULT_ID = `rrs_${base64urlEncode(bytes(32, 0x20))}`;
const CHAT_ID = `rcl_${base64urlEncode(bytes(16, 0x80))}`;
const TRIGGER_ID = `rio_${base64urlEncode(bytes(32, 0x40))}`;
const ATTEMPT_ID = `rda_${base64urlEncode(bytes(16, 0x60))}`;
const OTHER_ATTEMPT_ID = `rda_${base64urlEncode(bytes(16, 0x70))}`;

const PROJECTION_VALUE = Object.freeze({
  v: 1,
  resultId: RESULT_ID,
  clientMsgId: "client.msg-1",
  seq: 23,
} as const);

const PROJECTION_JSON = `{"v":1,"result_id":"${RESULT_ID}","client_msg_id":"client.msg-1","seq":23}`;

const ACTION_VALUE = Object.freeze({
  v: 1,
  resultId: RESULT_ID,
  sourceMsgId: "source.msg-1",
  sourceRecordKind: "user",
  decision: "rejected",
  commandSeq: 17,
} as const);

const ACTION_JSON =
  `{"v":1,"result_id":"${RESULT_ID}","source_msg_id":"source.msg-1",` +
  `"source_record_kind":"user","decision":"rejected","command_seq":17}`;

const CHAT_CREATION_VALUE = Object.freeze({
  v: 1,
  resultId: RESULT_ID,
  sourceMsgId: "new-chat.msg-1",
  decision: "rejected",
  targetLogicalChatId: null,
  commandSeq: 18,
} as const);

const CHAT_CREATION_JSON =
  `{"v":1,"result_id":"${RESULT_ID}","source_msg_id":"new-chat.msg-1",` +
  `"decision":"rejected","target_logical_chat_id":null,"command_seq":18}`;

const ADMITTED_CHAT_CREATION_VALUE = Object.freeze({
  v: 1,
  resultId: RESULT_ID,
  sourceMsgId: "new-chat.msg-2",
  decision: "admitted",
  targetLogicalChatId: CHAT_ID,
  commandSeq: 19,
} as const);

const ADMITTED_CHAT_CREATION_JSON =
  `{"v":1,"result_id":"${RESULT_ID}","source_msg_id":"new-chat.msg-2",` +
  `"decision":"admitted","target_logical_chat_id":"${CHAT_ID}","command_seq":19}`;

function cursor(channelGeneration: number, frameIndex: number): BrokerChannelCursorV1 {
  return Object.freeze({ version: 1, channelGeneration, frameIndex });
}

describe("selected A1 result schemas", () => {
  it("freezes the three semantic-result schema IDs and digest domains", () => {
    expect(A1_PROJECTION_ACCEPTED_PAYLOAD_SCHEMA_ID).toBe("remote-claw/a1-projection-accepted/v1");
    expect(A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID).toBe("remote-claw/a1-action-result/v1");
    expect(A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID).toBe(
      "remote-claw/a1-chat-creation-result/v1",
    );
    expect(A1_STORED_SEMANTIC_RESULT_DOMAIN).toBe("remote-claw/a1/stored-semantic-result/v1");
    expect(A1_RESULT_DELIVERY_ID_DOMAIN).toBe("remote-claw/a1/result-delivery/v1");
  });
});

describe("projection-accepted payload", () => {
  it("emits, parses, and digests one hardcoded exact compact vector", async () => {
    expect(encodeA1ProjectionAcceptedPayloadV1(PROJECTION_VALUE)).toBe(PROJECTION_JSON);
    const payload = encodeA1ProjectionAcceptedPayloadV1Bytes(PROJECTION_VALUE);
    expect(new TextDecoder().decode(payload)).toBe(PROJECTION_JSON);
    expect(parseA1ProjectionAcceptedPayloadV1(PROJECTION_JSON)).toEqual(PROJECTION_VALUE);
    expect(parseA1ProjectionAcceptedPayloadV1(payload)).toEqual(PROJECTION_VALUE);
    expect(
      await a1StoredSemanticResultDigest({
        storedSemanticResultSchemaId: A1_PROJECTION_ACCEPTED_PAYLOAD_SCHEMA_ID,
        exactCompactUtf8Payload: payload,
      }),
    ).toBe("h_hlJK86WyA-WbdekqpAGP-R7fVb3121CavaKgQUJIY");
  });

  it.each([
    [` ${PROJECTION_JSON}`, /exact compact JSON/],
    [
      PROJECTION_JSON.replace(
        `{"v":1,"result_id":"${RESULT_ID}"`,
        `{"result_id":"${RESULT_ID}","v":1`,
      ),
      /exact compact JSON/,
    ],
    [PROJECTION_JSON.replace('"seq":23', '"seq":2.3e1'), /exact compact JSON/],
    [PROJECTION_JSON.replace("client.msg-1", "client\\u002emsg-1"), /exact compact JSON/],
    [PROJECTION_JSON.replace('"seq":23', '"seq":23,"extra":true'), /exactly/],
    [PROJECTION_JSON.replace("client.msg-1", "client/msg-1"), /matching/],
    [PROJECTION_JSON.replace(RESULT_ID, "rrs_not-canonical"), /canonical unpadded base64url/],
  ])("rejects hostile or non-canonical bytes %#", (raw, message) => {
    expect(() => parseA1ProjectionAcceptedPayloadV1(raw)).toThrow(message);
  });

  it("rejects non-canonical encoder integers and extra fields", () => {
    expect(() => encodeA1ProjectionAcceptedPayloadV1({ ...PROJECTION_VALUE, seq: -0 })).toThrow(
      /non-negative safe integer/,
    );
    expect(() => encodeA1ProjectionAcceptedPayloadV1({ ...PROJECTION_VALUE, extra: true })).toThrow(
      /exactly/,
    );
  });
});

describe("rejected action result payload", () => {
  it("emits and parses the exact compact wire bytes", () => {
    expect(encodeA1RejectedActionResultPayloadV1(ACTION_VALUE)).toBe(ACTION_JSON);
    expect(new TextDecoder().decode(encodeA1RejectedActionResultPayloadV1Bytes(ACTION_VALUE))).toBe(
      ACTION_JSON,
    );
    expect(parseA1RejectedActionResultPayloadV1(ACTION_JSON)).toEqual(ACTION_VALUE);
    expect(parseA1RejectedActionResultPayloadV1(new TextEncoder().encode(ACTION_JSON))).toEqual(
      ACTION_VALUE,
    );
  });

  it.each([
    [` ${ACTION_JSON}`, /exact compact JSON/],
    [ACTION_JSON.replace('"v":1,"result_id"', '"result_id":"x","v":1,"ignored"'), /exactly/],
    [ACTION_JSON.replace('"decision":"rejected"', '"decision":"admitted"'), /rejected/],
    [
      ACTION_JSON.replace('"source_record_kind":"user"', '"source_record_kind":"admin"'),
      /must be user/,
    ],
    [ACTION_JSON.replace('"command_seq":17', '"command_seq":1.7e1'), /exact compact JSON/],
    [
      ACTION_JSON.replace('"source_record_kind":"user"', '"source_record_kind":"u\\u0073er"'),
      /exact compact JSON/,
    ],
    [ACTION_JSON.replace(RESULT_ID, "rrs_not-canonical"), /canonical unpadded base64url/],
  ])("rejects non-canonical or changed bytes %#", (raw, message) => {
    expect(() => parseA1RejectedActionResultPayloadV1(raw)).toThrow(message);
  });

  it("rejects non-plain and accessor-bearing encoder input", () => {
    expect(() => encodeA1RejectedActionResultPayloadV1(new Date())).toThrow(/plain object/);
    const value = { ...ACTION_VALUE } as Record<string, unknown>;
    Object.defineProperty(value, "commandSeq", { get: () => 17, enumerable: true });
    expect(() => encodeA1RejectedActionResultPayloadV1(value)).toThrow(/own data property/);
  });
});

describe("rejected chat-creation result payload", () => {
  it("emits and parses the exact compact wire bytes", () => {
    expect(encodeA1RejectedChatCreationResultPayloadV1(CHAT_CREATION_VALUE)).toBe(
      CHAT_CREATION_JSON,
    );
    expect(
      new TextDecoder().decode(
        encodeA1RejectedChatCreationResultPayloadV1Bytes(CHAT_CREATION_VALUE),
      ),
    ).toBe(CHAT_CREATION_JSON);
    expect(parseA1RejectedChatCreationResultPayloadV1(CHAT_CREATION_JSON)).toEqual(
      CHAT_CREATION_VALUE,
    );
  });

  it.each([
    [`${CHAT_CREATION_JSON}\n`, /exact compact JSON/],
    [
      CHAT_CREATION_JSON.replace(
        '"target_logical_chat_id":null',
        '"target_logical_chat_id":"rcl_not-canonical"',
      ),
      /must be null/,
    ],
    [CHAT_CREATION_JSON.replace('"decision":"rejected"', '"decision":"admitted"'), /rejected/],
    [CHAT_CREATION_JSON.replace('"command_seq":18', '"command_seq":18.0'), /exact compact JSON/],
    [CHAT_CREATION_JSON.replace(RESULT_ID, OTHER_RESULT_ID).replace('"v":1,', ""), /exactly/],
  ])("rejects non-canonical or changed bytes %#", (raw, message) => {
    expect(() => parseA1RejectedChatCreationResultPayloadV1(raw)).toThrow(message);
  });
});

describe("admitted chat-creation result payload", () => {
  it("emits, parses, and digests one hardcoded exact compact vector", async () => {
    expect(encodeA1AdmittedChatCreationResultPayloadV1(ADMITTED_CHAT_CREATION_VALUE)).toBe(
      ADMITTED_CHAT_CREATION_JSON,
    );
    const payload = encodeA1AdmittedChatCreationResultPayloadV1Bytes(ADMITTED_CHAT_CREATION_VALUE);
    expect(new TextDecoder().decode(payload)).toBe(ADMITTED_CHAT_CREATION_JSON);
    expect(parseA1AdmittedChatCreationResultPayloadV1(ADMITTED_CHAT_CREATION_JSON)).toEqual(
      ADMITTED_CHAT_CREATION_VALUE,
    );
    expect(parseA1AdmittedChatCreationResultPayloadV1(payload)).toEqual(
      ADMITTED_CHAT_CREATION_VALUE,
    );
    expect(
      await a1StoredSemanticResultDigest({
        storedSemanticResultSchemaId: A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
        exactCompactUtf8Payload: payload,
      }),
    ).toBe("evco22scBo0dy3ys0641BIuhoOYQntl66JKsJe9Mt8U");
  });

  it.each([
    [`${ADMITTED_CHAT_CREATION_JSON}\n`, /exact compact JSON/],
    [
      ADMITTED_CHAT_CREATION_JSON.replace('"decision":"admitted"', '"decision":"rejected"'),
      /must be admitted/,
    ],
    [
      ADMITTED_CHAT_CREATION_JSON.replace(
        `"target_logical_chat_id":"${CHAT_ID}"`,
        '"target_logical_chat_id":null',
      ),
      /must be non-null/,
    ],
    [ADMITTED_CHAT_CREATION_JSON.replace(CHAT_ID, "rcl_not-canonical"), /canonical unpadded/],
    [
      ADMITTED_CHAT_CREATION_JSON.replace('"command_seq":19', '"command_seq":1.9e1'),
      /exact compact JSON/,
    ],
    [ADMITTED_CHAT_CREATION_JSON.replace('"command_seq":19', '"command_seq":19.0'), /exact/],
    [
      ADMITTED_CHAT_CREATION_JSON.replace(
        '"source_msg_id":"new-chat.msg-2"',
        '"source_msg_id":"new-chat\\u002emsg-2"',
      ),
      /exact compact JSON/,
    ],
    [
      ADMITTED_CHAT_CREATION_JSON.replace('"command_seq":19', '"command_seq":19,"extra":null'),
      /exactly/,
    ],
  ])("rejects hostile, cross-branch, or non-canonical bytes %#", (raw, message) => {
    expect(() => parseA1AdmittedChatCreationResultPayloadV1(raw)).toThrow(message);
  });

  it("keeps admitted and rejected wrappers branch-exact", () => {
    expect(() =>
      encodeA1AdmittedChatCreationResultPayloadV1({
        ...ADMITTED_CHAT_CREATION_VALUE,
        decision: "rejected",
        targetLogicalChatId: null,
      }),
    ).toThrow(/must be admitted/);
    expect(() =>
      encodeA1RejectedChatCreationResultPayloadV1({
        ...CHAT_CREATION_VALUE,
        decision: "admitted",
        targetLogicalChatId: CHAT_ID,
      }),
    ).toThrow(/must be rejected/);
  });
});

describe("stored semantic-result digest", () => {
  it("writes the frozen domain, schema, and exact compact UTF-8 bytes in order", async () => {
    const payload = encodeA1RejectedActionResultPayloadV1Bytes(ACTION_VALUE);
    const input = {
      storedSemanticResultSchemaId: A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID,
      exactCompactUtf8Payload: payload,
    } as const;
    const expectedWriter = new CanonicalWriter();
    expectedWriter.str(A1_STORED_SEMANTIC_RESULT_DOMAIN);
    expectedWriter.str(A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID);
    expectedWriter.bytes(payload);
    expect(canonicalA1StoredSemanticResultPreimage(input)).toEqual(expectedWriter.finish());
    expect(await a1StoredSemanticResultDigest(input)).toBe(
      "LIjNXMy93DCCDs52vxvkFUw7-MZADiYWquZ5XZmVIOU",
    );
  });

  it("domain-separates the same payload under another selected schema", async () => {
    const payload = encodeA1RejectedActionResultPayloadV1Bytes(ACTION_VALUE);
    const actionDigest = await a1StoredSemanticResultDigest({
      storedSemanticResultSchemaId: A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID,
      exactCompactUtf8Payload: payload,
    });
    const chatDigest = await a1StoredSemanticResultDigest({
      storedSemanticResultSchemaId: A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
      exactCompactUtf8Payload: payload,
    });
    expect(chatDigest).not.toBe(actionDigest);
  });

  it("snapshots caller bytes and rejects unselected schemas", async () => {
    const payload = encodeA1RejectedActionResultPayloadV1Bytes(ACTION_VALUE);
    const pending = a1StoredSemanticResultDigest({
      storedSemanticResultSchemaId: A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID,
      exactCompactUtf8Payload: payload,
    });
    payload.fill(0xff);
    expect(await pending).toBe("LIjNXMy93DCCDs52vxvkFUw7-MZADiYWquZ5XZmVIOU");
    expect(() =>
      canonicalA1StoredSemanticResultPreimage({
        storedSemanticResultSchemaId: "remote-claw/a1/action-result/v1",
        exactCompactUtf8Payload: payload,
      }),
    ).toThrow(/selected A1 semantic-result schema ID/);
  });
});

describe("selected A1 result identity and delivery identity", () => {
  it("uses the existing rrs identity as both ingress and stable semantic result ID", () => {
    expect(
      parseA1IngressResultIdentity({
        ingressResultId: RESULT_ID,
        stableSemanticResultId: RESULT_ID,
      }),
    ).toEqual({ ingressResultId: RESULT_ID, stableSemanticResultId: RESULT_ID });
    expect(() =>
      parseA1IngressResultIdentity({
        ingressResultId: RESULT_ID,
        stableSemanticResultId: OTHER_RESULT_ID,
      }),
    ).toThrow(/must equal/);
  });

  it("derives rrd from only the ingress result and triggering ingress observation", async () => {
    const input = { ingressResultId: RESULT_ID, triggerIngressObservationId: TRIGGER_ID } as const;
    const expectedWriter = new CanonicalWriter();
    expectedWriter.str(A1_RESULT_DELIVERY_ID_DOMAIN);
    expectedWriter.str(RESULT_ID);
    expectedWriter.str(TRIGGER_ID);
    expect(canonicalA1ResultDeliveryIdPreimage(input)).toEqual(expectedWriter.finish());
    expect(await deriveA1ResultDeliveryId(input)).toBe(
      "rrd_hXqgWDJmuQ_U49mX1xuzAZobmXxs-UQTEJWx08FDdWc",
    );
  });

  it("rejects non-canonical result and observation identities", async () => {
    await expect(
      deriveA1ResultDeliveryId({
        ingressResultId: "rrs_not-canonical",
        triggerIngressObservationId: TRIGGER_ID,
      }),
    ).rejects.toThrow(/canonical unpadded base64url/);
    await expect(
      deriveA1ResultDeliveryId({
        ingressResultId: RESULT_ID,
        triggerIngressObservationId: "rio_not-canonical",
      }),
    ).rejects.toThrow(/canonical unpadded base64url/);
  });
});

describe("accepted-candidate completion observation", () => {
  const observation = (
    part: number,
    position: BrokerChannelCursorV1,
    overrides: Partial<{
      ingressObservationId: string;
      deliveryAttemptId: string;
      parts: number;
      disposition: "new_part";
    }> = {},
  ) => ({
    ingressObservationId: `rio_${base64urlEncode(bytes(32, 0x80 + part))}`,
    deliveryAttemptId: ATTEMPT_ID,
    cursor: position,
    part,
    parts: 3,
    disposition: "new_part" as const,
    ...overrides,
  });

  it("selects the route-ordered greatest new-part observation after proving completeness", () => {
    const first = observation(0, cursor(4, 4095));
    const completion = observation(1, cursor(5, 1));
    const middle = observation(2, cursor(5, 0));
    const unrelated = observation(0, cursor(99, 1), {
      ingressObservationId: TRIGGER_ID,
      deliveryAttemptId: OTHER_ATTEMPT_ID,
    });
    expect(
      selectA1CompletionObservation({
        acceptedDeliveryAttemptId: ATTEMPT_ID,
        expectedParts: 3,
        observations: [completion, unrelated, first, middle],
      }),
    ).toEqual({
      triggerIngressObservationId: completion.ingressObservationId,
      terminalIngressCursor: completion.cursor,
    });
  });

  it("rejects missing, duplicate, or inconsistent accepted parts", () => {
    const complete = [
      observation(0, cursor(1, 0)),
      observation(1, cursor(1, 1)),
      observation(2, cursor(1, 2)),
    ] as const;
    expect(() =>
      selectA1CompletionObservation({
        acceptedDeliveryAttemptId: ATTEMPT_ID,
        expectedParts: 3,
        observations: complete.slice(0, 2),
      }),
    ).toThrow(/exactly one new_part observation for every expected part/);
    expect(() =>
      selectA1CompletionObservation({
        acceptedDeliveryAttemptId: ATTEMPT_ID,
        expectedParts: 3,
        observations: [complete[0], complete[0], complete[1], complete[2]],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      selectA1CompletionObservation({
        acceptedDeliveryAttemptId: ATTEMPT_ID,
        expectedParts: 3,
        observations: [complete[0], complete[1], observation(2, cursor(1, 2), { parts: 4 })],
      }),
    ).toThrow(/coordinates are inconsistent/);
  });

  it("returns typed contract errors instead of accepting an invalid attempt ID", () => {
    try {
      selectA1CompletionObservation({
        acceptedDeliveryAttemptId: "rda_not-canonical",
        expectedParts: 1,
        observations: [],
      });
      throw new Error("expected result contract rejection");
    } catch (error) {
      expect(A1ResultContractError.is(error)).toBe(true);
      expect((error as A1ResultContractError).reason).toBe("invalid-field");
    }
  });
});
