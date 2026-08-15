import { describe, expect, it } from "vitest";
import {
  A1_INGRESS_ASSEMBLY_DEADLINE_MS,
  A1_INGRESS_LOOKAHEAD_MAX_BYTES,
  A1_INGRESS_LOOKAHEAD_MAX_FRAMES,
  A1_INGRESS_MAX_CANDIDATES_PER_RESULT,
  A1_INGRESS_MAX_OPENED_PART_BYTES,
  A1_INGRESS_MAX_PARTS,
  A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE,
  A1_INGRESS_MAX_UNRESOLVED_RESULTS_PER_ROUTE,
  A1_INGRESS_NEW_CHAT_PAYLOAD_SCHEMA_ID,
  A1_INGRESS_SCHEDULER_CONCURRENCY,
  A1_INGRESS_USER_PAYLOAD_SCHEMA_ID,
  A1IngressContractError,
  type A1IngressRoute,
  a1IngressAuthenticatedPartDigest,
  a1IngressCanonicalMessageDigest,
  a1IngressSourceEventFingerprint,
  a1IngressStableLogicalHeaderDigest,
  assertA1WebSourceNamespaceId,
  canonicalA1ChannelPositionObservationPreimage,
  canonicalA1IngressObservationPreimage,
  canonicalA1IngressSourceEventFingerprintPreimage,
  canonicalA1IngressStableLogicalHeader,
  canonicalA1StableSemanticResultPreimage,
  canonicalA1WebSourceNamespacePreimage,
  compareA1BrokerChannelCursors,
  deriveA1ChannelPositionObservationId,
  deriveA1IngressObservationId,
  deriveA1StableSemanticResultId,
  deriveA1WebSourceNamespaceId,
  encodeA1IngressNewChatPayloadV1,
  encodeA1IngressNewChatPayloadV1Bytes,
  encodeA1IngressUserPayloadV1,
  encodeA1IngressUserPayloadV1Bytes,
  isA1BrokerChannelCursorSuccessor,
  parseA1IngressNewChatPayloadV1,
  parseA1IngressUserPayloadV1,
  parseSelectedA1InboundPayload,
  successorA1BrokerChannelCursor,
} from "./a1-ingress.js";
import {
  type A1FrameHeaderV2,
  a1AttemptHeaderDigest,
  a1AuthenticatedPartDigest,
  a1CanonicalMessageDigest,
  canonicalA1StableLogicalHeader,
} from "./a1-wire.js";
import { base64urlEncode } from "./base64url.js";
import { utf8 } from "./bytes.js";

function bytes(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

const IDENTITY_ID = bytes(16, 0);
const SERVER_ID = "rcs_EBESExQVFhcYGRobHB0eHw";
const OTHER_SERVER_ID = "rcs_ERITFBUWFxgZGhscHR4fIA";
const CHAT_ID = "rcl_ICEiIyQlJicoKSorLC0uLw";
const ROUTE_ID = "rcr_rvrPIEXeJZ-TQvkWgfyYJgMl99GFWA4_reIVFFBzsec";
const OTHER_ROUTE_ID = "rcr_PiK9eO4dC7KKoRfNEhNLyFDdk3QE43pBoQBs8-EP6V4";
const ATTEMPT_ID = "rda_MDEyMzQ1Njc4OTo7PD0-Pw";

function chatRoute(overrides: Partial<A1IngressRoute> = {}): A1IngressRoute {
  return {
    routeKind: "chat",
    identityId: IDENTITY_ID,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
    ...overrides,
  } as A1IngressRoute;
}

function serverControlRoute(overrides: Partial<A1IngressRoute> = {}): A1IngressRoute {
  return {
    routeKind: "server_control",
    identityId: IDENTITY_ID,
    collaborationServerId: SERVER_ID,
    logicalChatId: null,
    ...overrides,
  } as A1IngressRoute;
}

function userHeader(overrides: Partial<A1FrameHeaderV2> = {}): A1FrameHeaderV2 {
  return {
    v: 2,
    identityId: IDENTITY_ID,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: "source.msg-1",
    deliveryAttemptId: ATTEMPT_ID,
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

function newChatHeader(overrides: Partial<A1FrameHeaderV2> = {}): A1FrameHeaderV2 {
  return userHeader({
    logicalChatId: null,
    recordKind: "new_chat",
    msgId: "source.new-chat-1",
    clientMsgId: "client:new-chat-1",
    ...overrides,
  });
}

describe("selected A1.7a ingress resource contract", () => {
  it("locks every selected bound", () => {
    expect({
      parts: A1_INGRESS_MAX_PARTS,
      candidatesPerResult: A1_INGRESS_MAX_CANDIDATES_PER_RESULT,
      maxReassembledPlaintext: A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES,
      maxOpenedPart: A1_INGRESS_MAX_OPENED_PART_BYTES,
      assemblyDeadlineMs: A1_INGRESS_ASSEMBLY_DEADLINE_MS,
      lookaheadFrames: A1_INGRESS_LOOKAHEAD_MAX_FRAMES,
      lookaheadBytes: A1_INGRESS_LOOKAHEAD_MAX_BYTES,
      unresolvedResultsPerRoute: A1_INGRESS_MAX_UNRESOLVED_RESULTS_PER_ROUTE,
      retainedPlaintextPerRoute: A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE,
      retainedPlaintextPerIdentity: A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY,
      retainedPlaintextGlobal: A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL,
      schedulerConcurrency: A1_INGRESS_SCHEDULER_CONCURRENCY,
    }).toEqual({
      parts: 32,
      candidatesPerResult: 4,
      maxReassembledPlaintext: 50_331_648,
      maxOpenedPart: 3_299_983,
      assemblyDeadlineMs: 300_000,
      lookaheadFrames: 1_024,
      lookaheadBytes: 67_108_864,
      unresolvedResultsPerRoute: 256,
      retainedPlaintextPerRoute: 536_870_912,
      retainedPlaintextPerIdentity: 2_147_483_648,
      retainedPlaintextGlobal: 4_294_967_296,
      schedulerConcurrency: 8,
    });
  });
});

describe("route-lifetime and observation identities", () => {
  it("locks independent canonical preimage and identifier vectors", async () => {
    const route = chatRoute();
    const namespace = await deriveA1WebSourceNamespaceId(route);
    const semanticResult = await deriveA1StableSemanticResultId(route, namespace, "source.msg-1");
    const cursor = { version: 1 as const, channelGeneration: 7, frameIndex: 41 };
    const position = await deriveA1ChannelPositionObservationId(ROUTE_ID, cursor);
    const observation = await deriveA1IngressObservationId(position);

    expect({
      namespacePreimage: base64urlEncode(canonicalA1WebSourceNamespacePreimage(route)),
      namespace,
      semanticResultPreimage: base64urlEncode(
        canonicalA1StableSemanticResultPreimage(route, namespace, "source.msg-1"),
      ),
      semanticResult,
      positionPreimage: base64urlEncode(
        canonicalA1ChannelPositionObservationPreimage(ROUTE_ID, cursor),
      ),
      position,
      observationPreimage: base64urlEncode(canonicalA1IngressObservationPreimage(position)),
      observation,
    }).toEqual({
      namespacePreimage:
        "AAAAJnJlbW90ZS1jbGF3L2ExL3dlYi1zb3VyY2UtbmFtZXNwYWNlL3YxAAAAEAABAgMEBQYHCAkKCwwNDg8AAAAacmNzX0VCRVNFeFFWRmhjWUdSb2JIQjBlSHcAAAAEY2hhdAEAAAAacmNsX0lDRWlJeVFsSmljb0tTb3JMQzB1THc",
      namespace: "wns_ZLL2tOWVRao2qR6RI63dBzToaRTaO9SP4TSZfgNFMj8",
      semanticResultPreimage:
        "AAAAIXJlbW90ZS1jbGF3L2ExL3NlbWFudGljLXJlc3VsdC92MQAAABAAAQIDBAUGBwgJCgsMDQ4PAAAAGnJjc19FQkVTRXhRVkZoY1lHUm9iSEIwZUh3AAAABGNoYXQBAAAAGnJjbF9JQ0VpSXlRbEppY29LU29yTEMwdUx3AAAAL3duc19aTEwydE9XVlJhbzJxUjZSSTYzZEJ6VG9hUlRhTzlTUDRUU1pmZ05GTWo4AAAADHNvdXJjZS5tc2ctMQ",
      semanticResult: "rrs_S8Vw_HRqtz8RUdxJL2q7KXVjLE3wogsVTq5FJ1I6klQ",
      positionPreimage:
        "AAAAInJlbW90ZS1jbGF3L2ExL2NoYW5uZWwtcG9zaXRpb24vdjEAAAAvcmNyX3J2clBJRVhlSlotVFF2a1dnZnlZSmdNbDk5R0ZXQTRfcmVJVkZGQnpzZWMAAAAIAAAAAAAAAAcAAAAIAAAAAAAAACk",
      position: "rcp_YMjXsn-t9H2brfWn5Q0-U8OMcI91K5nRDy634iLp8dg",
      observationPreimage:
        "AAAAJXJlbW90ZS1jbGF3L2ExL2luZ3Jlc3Mtb2JzZXJ2YXRpb24vdjEAAAAvcmNwX1lNalhzbi10OUgyYnJmV241UTAtVThPTWNJOTFLNW5SRHk2MzRpTHA4ZGc",
      observation: "rio_zVgXM9T7Yv6Ig-W6LRA9JDSCreVv5K0Fo_vJ9uvo9GE",
    });
  });

  it("binds namespaces and semantic results to the complete route", async () => {
    const route = chatRoute();
    const namespace = await deriveA1WebSourceNamespaceId(route);
    const changedRoute = chatRoute({ collaborationServerId: OTHER_SERVER_ID });
    const changedNamespace = await deriveA1WebSourceNamespaceId(changedRoute);

    expect(changedNamespace).not.toBe(namespace);
    expect(await deriveA1WebSourceNamespaceId(serverControlRoute())).not.toBe(namespace);
    await expect(assertA1WebSourceNamespaceId(changedRoute, namespace)).rejects.toMatchObject({
      reason: "route-mismatch",
    });
    await expect(
      deriveA1StableSemanticResultId(changedRoute, namespace, "source.msg-1"),
    ).rejects.toMatchObject({ reason: "route-mismatch" });
    expect(
      await deriveA1StableSemanticResultId(changedRoute, changedNamespace, "source.msg-1"),
    ).not.toBe(await deriveA1StableSemanticResultId(route, namespace, "source.msg-1"));
  });

  it("snapshots mutable identity bytes before hashing", async () => {
    const identityId = IDENTITY_ID.slice();
    const route = chatRoute({ identityId });
    const pending = deriveA1WebSourceNamespaceId(route);
    identityId.fill(0xff);
    expect(await pending).toBe(await deriveA1WebSourceNamespaceId(chatRoute()));
  });

  it("does not alias another route or physical cursor", async () => {
    const cursor = { version: 1 as const, channelGeneration: 7, frameIndex: 41 };
    const position = await deriveA1ChannelPositionObservationId(ROUTE_ID, cursor);
    expect(await deriveA1ChannelPositionObservationId(OTHER_ROUTE_ID, cursor)).not.toBe(position);
    expect(
      await deriveA1ChannelPositionObservationId(ROUTE_ID, { ...cursor, frameIndex: 42 }),
    ).not.toBe(position);
    expect(await deriveA1IngressObservationId(position)).not.toBe(
      await deriveA1IngressObservationId(
        await deriveA1ChannelPositionObservationId(ROUTE_ID, { ...cursor, frameIndex: 42 }),
      ),
    );
  });
});

describe("route-local cursor algebra", () => {
  it("compares lexicographically without comparing cursors from different routes implicitly", () => {
    const a = { version: 1 as const, channelGeneration: 1, frameIndex: 9 };
    const b = { version: 1 as const, channelGeneration: 2, frameIndex: 0 };
    expect(compareA1BrokerChannelCursors(a, a)).toBe(0);
    expect(compareA1BrokerChannelCursors(a, b)).toBe(-1);
    expect(compareA1BrokerChannelCursors(b, a)).toBe(1);
  });

  it("uses a proved sealed frame count for within/across-generation successors", () => {
    expect(
      successorA1BrokerChannelCursor({ version: 1, channelGeneration: 5, frameIndex: 2 }, 4),
    ).toEqual({ version: 1, channelGeneration: 5, frameIndex: 3 });
    expect(
      successorA1BrokerChannelCursor({ version: 1, channelGeneration: 5, frameIndex: 3 }, 4),
    ).toEqual({ version: 1, channelGeneration: 6, frameIndex: 0 });
    expect(
      isA1BrokerChannelCursorSuccessor(
        { version: 1, channelGeneration: 5, frameIndex: 3 },
        { version: 1, channelGeneration: 6, frameIndex: 0 },
        4,
      ),
    ).toBe(true);
    expect(
      isA1BrokerChannelCursorSuccessor(
        { version: 1, channelGeneration: 5, frameIndex: 3 },
        { version: 1, channelGeneration: 7, frameIndex: 0 },
        4,
      ),
    ).toBe(false);
  });

  it("does not infer a successor from an invalid/open manifest shape or exhaust a counter", () => {
    expect(() =>
      successorA1BrokerChannelCursor({ version: 1, channelGeneration: 5, frameIndex: 3 }, 3),
    ).toThrow(/outside the proved sealed generation/);
    expect(() =>
      successorA1BrokerChannelCursor({ version: 1, channelGeneration: 5, frameIndex: 0 }, 0),
    ).toThrow(/from 1 through 4096/);
    expect(() =>
      successorA1BrokerChannelCursor(
        { version: 1, channelGeneration: Number.MAX_SAFE_INTEGER, frameIndex: 0 },
        1,
      ),
    ).toThrow(/no safe-integer successor/);
  });
});

describe("stable ingress digests", () => {
  const plaintext = utf8('{"v":1,"text":"hello 🌐"}');

  it("reuses the exact wire header, part, and logical-message domains", async () => {
    const header = userHeader();
    expect(canonicalA1IngressStableLogicalHeader(header)).toEqual(
      canonicalA1StableLogicalHeader(header),
    );
    expect(await a1IngressStableLogicalHeaderDigest(header)).toBe(
      await a1AttemptHeaderDigest(header),
    );
    expect(await a1IngressAuthenticatedPartDigest(header, plaintext)).toBe(
      await a1AuthenticatedPartDigest(header, plaintext),
    );
    expect(await a1IngressCanonicalMessageDigest(header, plaintext)).toBe(
      await a1CanonicalMessageDigest(header, plaintext),
    );
  });

  it("locks header, part, message, and source-fingerprint vectors", async () => {
    const header = userHeader();
    const namespace = await deriveA1WebSourceNamespaceId(chatRoute());
    const headerDigest = await a1IngressStableLogicalHeaderDigest(header);
    const partDigest = await a1IngressAuthenticatedPartDigest(header, plaintext);
    const messageDigest = await a1IngressCanonicalMessageDigest(header, plaintext);
    const fingerprint = await a1IngressSourceEventFingerprint(
      ROUTE_ID,
      namespace,
      header.msgId,
      messageDigest,
    );
    expect({
      headerDigest,
      partDigest,
      messageDigest,
      fingerprintPreimage: base64urlEncode(
        canonicalA1IngressSourceEventFingerprintPreimage(
          ROUTE_ID,
          namespace,
          header.msgId,
          messageDigest,
        ),
      ),
      fingerprint,
    }).toEqual({
      headerDigest: "djbkwSz-t5HUO1uA9MbUrpzcsZUE4jYr26sT-QzrwUs",
      partDigest: "1xES9SjExk429KD6bu8JA2zFVhizDzWhiuuv5UtjBKA",
      messageDigest: "PGJ_IoxIYqMhPDzW2BXcwSWDZGcWjeTmTyz3ppBMM8U",
      fingerprintPreimage:
        "AAAAKnJlbW90ZS1jbGF3L2ExL3NvdXJjZS1ldmVudC1maW5nZXJwcmludC92MQAAAC9yY3JfcnZyUElFWGVKWi1UUXZrV2dmeVlKZ01sOTlHRldBNF9yZUlWRkZCenNlYwAAAC93bnNfWkxMMnRPV1ZSYW8ycVI2Ukk2M2RCelRvYVJUYU85U1A0VFNaZmdORk1qOAAAAAxzb3VyY2UubXNnLTEAAAAgPGJ_IoxIYqMhPDzW2BXcwSWDZGcWjeTmTyz3ppBMM8U",
      fingerprint: "vT7woNuSyHUB2XQMOA5Wlj7NqFvGWekYFnpztWUj9TU",
    });
  });

  it("excludes fresh attempt randomness but binds the stable semantic header", async () => {
    const original = userHeader();
    const freshAttempt = userHeader({ deliveryAttemptId: "rda_QEFCQ0RFRkdISUpLTE1OTw" });
    expect(await a1IngressStableLogicalHeaderDigest(freshAttempt)).toBe(
      await a1IngressStableLogicalHeaderDigest(original),
    );
    expect(await a1IngressCanonicalMessageDigest(freshAttempt, plaintext)).toBe(
      await a1IngressCanonicalMessageDigest(original, plaintext),
    );
    expect(
      await a1IngressCanonicalMessageDigest(userHeader({ msgId: "source.msg-2" }), plaintext),
    ).not.toBe(await a1IngressCanonicalMessageDigest(original, plaintext));
  });

  it("enforces direction, part count, opened-part, and whole-message bounds", async () => {
    await expect(
      a1IngressStableLogicalHeaderDigest(
        userHeader({
          dir: "out",
          seq: 1,
          serverKeyGeneration: 1,
          hostSignerIdentityKeyId: "key.1",
          hostScopeCertificateId: "cert.1",
          hostSignatureSequence: 1,
        }),
      ),
    ).rejects.toThrow(/ingress header must be inbound/);
    await expect(
      a1IngressStableLogicalHeaderDigest(userHeader({ part: 0, parts: 33 })),
    ).rejects.toThrow(/must not exceed 32/);
    await expect(
      a1IngressAuthenticatedPartDigest(
        userHeader(),
        new Uint8Array(A1_INGRESS_MAX_OPENED_PART_BYTES + 1),
      ),
    ).rejects.toThrow(/must not exceed 3299983/);
    await expect(
      a1IngressCanonicalMessageDigest(
        userHeader(),
        new Uint8Array(A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES + 1),
      ),
    ).rejects.toThrow(/must not exceed 50331648/);
  });
});

describe("selected inbound payload codecs", () => {
  it("locks the source-only schema IDs and exact compact user JSON", () => {
    expect(A1_INGRESS_USER_PAYLOAD_SCHEMA_ID).toBe("remote-claw/a1-ingress-user/v1");
    expect(A1_INGRESS_NEW_CHAT_PAYLOAD_SCHEMA_ID).toBe("remote-claw/a1-ingress-new-chat/v1");
    const payload = { v: 1 as const, text: "line 1\n🌐 / no normalization" };
    const encoded = '{"v":1,"text":"line 1\\n🌐 / no normalization"}';
    expect(encodeA1IngressUserPayloadV1(payload)).toBe(encoded);
    expect(encodeA1IngressUserPayloadV1Bytes(payload)).toEqual(utf8(encoded));
    expect(parseA1IngressUserPayloadV1(encoded)).toEqual(payload);
    expect(parseA1IngressUserPayloadV1(utf8(encoded))).toEqual(payload);
  });

  it.each([
    '{"text":"x","v":1}',
    '{ "v":1,"text":"x"}',
    '{"v":1.0,"text":"x"}',
    '{"v":1,"text":"x","text":"x"}',
    '{"v":1,"text":"x","extra":0}',
    '{"v":1,"text":"\\u0078"}',
    '{"v":1,"text":"\\/"}',
  ])("rejects noncanonical or duplicate user JSON: %s", (raw) => {
    expect(() => parseA1IngressUserPayloadV1(raw)).toThrow(A1IngressContractError);
  });

  it("rejects invalid UTF-8, BOM, lone surrogates, and oversized whole messages", () => {
    expect(() => parseA1IngressUserPayloadV1(Uint8Array.of(0xc3, 0x28))).toThrow(/UTF-8/);
    expect(() => parseA1IngressUserPayloadV1(utf8('\uFEFF{"v":1,"text":"x"}'))).toThrow(/BOM/);
    expect(() => parseA1IngressUserPayloadV1('{"v":1,"text":"\\ud800"}')).toThrow(/Unicode scalar/);
    expect(() =>
      parseA1IngressUserPayloadV1(new Uint8Array(A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES + 1)),
    ).toThrow(/must not exceed 50331648/);
  });

  it("locks exact compact new-chat JSON and safe selector validation", () => {
    const value = {
      v: 1 as const,
      intent: "first_bootstrap" as const,
      projectId: "rcpj.project-1",
      workspaceSelectorId: "workspace:primary",
    };
    const encoded =
      '{"v":1,"intent":"first_bootstrap","project_id":"rcpj.project-1","workspace_selector_id":"workspace:primary"}';
    expect(encodeA1IngressNewChatPayloadV1(value)).toBe(encoded);
    expect(encodeA1IngressNewChatPayloadV1Bytes(value)).toEqual(utf8(encoded));
    expect(parseA1IngressNewChatPayloadV1(encoded)).toEqual(value);
    expect(() =>
      parseA1IngressNewChatPayloadV1(
        '{"v":1,"intent":"first_bootstrap","workspace_selector_id":"workspace:primary","project_id":"rcpj.project-1"}',
      ),
    ).toThrow(/exact compact JSON/);
    expect(() =>
      parseA1IngressNewChatPayloadV1(
        '{"v":1,"intent":"resume","project_id":"p","workspace_selector_id":"w"}',
      ),
    ).toThrow(/first_bootstrap or new_chat/);
    expect(() =>
      parseA1IngressNewChatPayloadV1(
        '{"v":1,"intent":"new_chat","project_id":"bad id","workspace_selector_id":"w"}',
      ),
    ).toThrow(/safe|matching/);
  });

  it("dispatches only user and new_chat and leaves other recognized kinds unsupported", () => {
    const user = parseSelectedA1InboundPayload(userHeader(), '{"v":1,"text":"hello"}');
    expect(user).toMatchObject({
      recordKind: "user",
      sourcePayloadSchemaId: A1_INGRESS_USER_PAYLOAD_SCHEMA_ID,
      payload: { v: 1, text: "hello" },
    });
    expect(user.canonicalBytes).toEqual(utf8('{"v":1,"text":"hello"}'));

    const creation = parseSelectedA1InboundPayload(
      newChatHeader(),
      '{"v":1,"intent":"new_chat","project_id":"p","workspace_selector_id":"w"}',
    );
    expect(creation).toMatchObject({
      recordKind: "new_chat",
      sourcePayloadSchemaId: A1_INGRESS_NEW_CHAT_PAYLOAD_SCHEMA_ID,
      payload: { v: 1, intent: "new_chat", projectId: "p", workspaceSelectorId: "w" },
    });

    expect(() =>
      parseSelectedA1InboundPayload(userHeader({ recordKind: "attachment" }), '{"v":1,"items":[]}'),
    ).toThrow(/has no selected A1.7a source payload schema/);
  });

  it("does not let a payload codec substitute for the selected route kind", () => {
    expect(() =>
      parseSelectedA1InboundPayload(
        userHeader({ logicalChatId: null }),
        '{"v":1,"text":"transplant"}',
      ),
    ).toThrow(/logicalChatId/);
    expect(() =>
      parseSelectedA1InboundPayload(
        newChatHeader({ logicalChatId: CHAT_ID }),
        '{"v":1,"intent":"new_chat","project_id":"p","workspace_selector_id":"w"}',
      ),
    ).toThrow(/null logicalChatId/);
  });
});
