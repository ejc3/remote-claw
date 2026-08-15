import { describe, expect, it } from "vitest";
import {
  A1_BROKER_CIPHERTEXT_LIMIT_BYTES,
  A1_BROKER_DEFAULT_READ_FRAMES,
  A1_BROKER_GENERATION_FRAME_CAP,
  A1_BROKER_MAX_PARTS,
  A1_BROKER_MAX_RAW_FRAME_BYTES,
  A1_BROKER_MAX_READ_ENCODED_BYTES,
  A1_BROKER_MAX_READ_FRAMES,
  type A1BrokerReadFrameV1,
  type A1BrokerRouteDescriptorV1,
  a1BrokerGenerationManifestDigest,
  brokerBackendCapabilitiesDigest,
  canonicalBrokerBackendCapabilitiesV1,
  encodeA1BrokerEnsureRouteReceiptV1,
  encodeA1BrokerPublishReceiptV1,
  encodeA1BrokerReadPageV1,
  encodeA1BrokerRouteDescriptorV1,
  encodeA1BrokerTransportCollisionV1,
  encodeBrokerChannelCursorV1,
  encodeBrokerChannelGenerationRecordV1,
  encodeBrokerReadPositionV1,
  parseA1BrokerCanonicalFrameV1,
  parseA1BrokerEnsureRouteReceiptV1,
  parseA1BrokerOrigin,
  parseA1BrokerPublishReceiptV1,
  parseA1BrokerReadPageV1,
  parseA1BrokerRouteDescriptorV1,
  parseA1BrokerRouteStoreInstanceId,
  parseA1BrokerTransportCollisionV1,
  parseBrokerBackendCapabilitiesV1,
  parseBrokerChannelCursorV1,
  parseBrokerChannelGenerationRecordV1,
  parseBrokerReadPositionV1,
  SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
} from "./a1-broker.js";
import {
  type A1EncryptedFrameV2,
  deriveA1BrokerRouteId,
  deriveA1ChatToken,
  encodeA1EncryptedFrameV2,
} from "./a1-wire.js";
import { base64urlEncode } from "./base64url.js";
import { sha256, toHex } from "./bytes.js";

function bytes(length: number, start = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

const IDENTITY = bytes(16, 0x10);
const IDENTITY_ID = toHex(IDENTITY);
const SERVER_ID = `rcs_${base64urlEncode(bytes(16, 0x20))}`;
const CHAT_ID = `rcl_${base64urlEncode(bytes(16, 0x30))}`;
const ATTEMPT_ID = `rda_${base64urlEncode(bytes(16, 0x40))}`;
const STORE_ID = `rbsi_${base64urlEncode(bytes(16, 0x50))}`;
const ZERO_DIGEST = base64urlEncode(new Uint8Array(32));
const ONE_DIGEST = base64urlEncode(new Uint8Array(32).fill(1));
const TWO_DIGEST = base64urlEncode(new Uint8Array(32).fill(2));

async function textDigest(value: string): Promise<string> {
  return base64urlEncode(await sha256(new TextEncoder().encode(value)));
}

function frame(overrides: Partial<A1EncryptedFrameV2> = {}): A1EncryptedFrameV2 {
  return {
    v: 2,
    identityId: IDENTITY,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: "message.one",
    deliveryAttemptId: ATTEMPT_ID,
    clientMsgId: "client.one",
    keyEpoch: 0,
    salt: bytes(32, 0x60),
    nonce: bytes(12, 0x80),
    ct: bytes(16, 0x90),
    part: 0,
    parts: 1,
    serverKeyGeneration: null,
    hostSignerIdentityKeyId: null,
    hostScopeCertificateId: null,
    hostSignatureSequence: null,
    hostSignature: null,
    ...overrides,
  };
}

async function routeDescriptor(): Promise<A1BrokerRouteDescriptorV1> {
  const brokerRouteId = await deriveA1BrokerRouteId({
    routeKind: "chat",
    identityId: IDENTITY,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
  });
  return {
    schemaVersion: 1,
    brokerOrigin: "https://broker.example",
    backendSelector: "sqlite",
    routeStoreInstanceId: STORE_ID,
    identityId: IDENTITY_ID,
    collaborationServerId: SERVER_ID,
    routeKind: "chat",
    logicalChatId: CHAT_ID,
    brokerRouteId,
    routeToken: await deriveA1ChatToken(IDENTITY, SERVER_ID, CHAT_ID),
    brokerBackendCapabilitiesDigest: await brokerBackendCapabilitiesDigest(
      SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
    ),
  };
}

async function readFrame(frameIndex = 0): Promise<A1BrokerReadFrameV1> {
  const inspected = await parseA1BrokerCanonicalFrameV1(encodeA1EncryptedFrameV2(frame()));
  return {
    schemaVersion: 1,
    cursor: { version: 1, channelGeneration: 0, frameIndex },
    deliveryAttemptId: ATTEMPT_ID,
    part: 0,
    transportFrameDigest: inspected.transportFrameDigest,
    canonicalFrame: inspected.canonicalFrame,
  };
}

describe("selected-A1 broker capability and bounds contract", () => {
  it("locks every selected bound and the existing capability vector", async () => {
    expect({
      raw: A1_BROKER_MAX_RAW_FRAME_BYTES,
      ciphertextExclusive: A1_BROKER_CIPHERTEXT_LIMIT_BYTES,
      parts: A1_BROKER_MAX_PARTS,
      generation: A1_BROKER_GENERATION_FRAME_CAP,
      defaultRead: A1_BROKER_DEFAULT_READ_FRAMES,
      maxRead: A1_BROKER_MAX_READ_FRAMES,
      readBytes: A1_BROKER_MAX_READ_ENCODED_BYTES,
    }).toEqual({
      raw: 4_450_000,
      ciphertextExclusive: 3_300_000,
      parts: 32,
      generation: 4_096,
      defaultRead: 64,
      maxRead: 64,
      readBytes: 8_000_000,
    });
    expect(await brokerBackendCapabilitiesDigest(SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1)).toBe(
      "pxq9w0eeR1rKMUyVw5p5Sgl6VU1jdEHAPYlrS93Cbdo",
    );
    expect(
      base64urlEncode(
        canonicalBrokerBackendCapabilitiesV1(SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1),
      ),
    ).toBe(
      "AAAAKnJlbW90ZS1jbGF3L2Jyb2tlci1iYWNrZW5kLWNhcGFiaWxpdGllcy92MQAAAAgAAAAAAAAAAQAAABVyZW1vdGUtY2xhdy1icm9rZXItYTEAAAAIAAAAAAAAAAEAAAAIAAAAAAAAAAEAAAAIAAAAAAAAAAEAAAAIAAAAAAAAAAEAAAAIAAAAAAAAAAEAAAAIAAAAAAAAAAE",
    );
  });

  it("rejects partial, downgraded, extended, inherited, and accessor capability vectors", () => {
    const { generationManifests: _, ...partial } = SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1;
    expect(() => parseBrokerBackendCapabilitiesV1(partial)).toThrow(/exactly the selected fields/);
    expect(() =>
      parseBrokerBackendCapabilitiesV1({
        ...SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
        durableCiphertext: false,
      }),
    ).toThrow(/durableCiphertext/);
    expect(() =>
      parseBrokerBackendCapabilitiesV1({
        ...SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
        future: true,
      }),
    ).toThrow(/exactly the selected fields/);
    expect(() =>
      parseBrokerBackendCapabilitiesV1(
        Object.assign(
          Object.create({ inherited: true }),
          SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
        ),
      ),
    ).toThrow(/plain object/);
    const accessor = { ...SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1 } as Record<string, unknown>;
    Object.defineProperty(accessor, "protocol", { get: () => "remote-claw-broker-a1" });
    expect(() => parseBrokerBackendCapabilitiesV1(accessor)).toThrow(/own data property/);
  });
});

describe("selected-A1 broker coordinates", () => {
  it("normalizes only unambiguous HTTP(S) origins and locks route-store IDs", () => {
    expect(parseA1BrokerOrigin("HTTPS://Broker.Example:443/")).toBe("https://broker.example");
    expect(parseA1BrokerOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const invalid of [
      "file:///tmp/broker",
      "https://user@broker.example",
      "https://broker.example/a",
      "https://broker.example/?a=1",
      "https://broker.example/#x",
      "//broker.example",
    ]) {
      expect(() => parseA1BrokerOrigin(invalid)).toThrow();
    }
    expect(() => parseA1BrokerOrigin(`https://${"a".repeat(1_025)}.example`)).toThrow(/1-1024/);
    expect(parseA1BrokerRouteStoreInstanceId(STORE_ID)).toBe(STORE_ID);
    expect(() => parseA1BrokerRouteStoreInstanceId(STORE_ID.replace("rbsi_", ""))).toThrow(/rbsi_/);
    expect(() => parseA1BrokerRouteStoreInstanceId(`${STORE_ID}A`)).toThrow(/base64url/);
  });

  it("locks cursor/read-position JSON and rejects negative zero, overflow, and cap aliases", () => {
    const cursor = { version: 1, channelGeneration: 7, frameIndex: 4_095 };
    const position = { version: 1, channelGeneration: 8, nextFrameIndex: 4_096 };
    expect(encodeBrokerChannelCursorV1(cursor)).toBe(
      '{"version":1,"channelGeneration":7,"frameIndex":4095}',
    );
    expect(encodeBrokerReadPositionV1(position)).toBe(
      '{"version":1,"channelGeneration":8,"nextFrameIndex":4096}',
    );
    expect(parseBrokerChannelCursorV1(cursor)).toEqual(cursor);
    expect(parseBrokerReadPositionV1(position)).toEqual(position);
    expect(() => parseBrokerChannelCursorV1({ ...cursor, frameIndex: 4_096 })).toThrow(/4095/);
    expect(() => parseBrokerReadPositionV1({ ...position, nextFrameIndex: 4_097 })).toThrow(/4096/);
    expect(() => parseBrokerReadPositionV1({ ...position, channelGeneration: -0 })).toThrow();
    expect(() => parseBrokerReadPositionV1({ ...position, extra: 1 })).toThrow(/exactly/);
  });

  it("derives the complete route tuple and emits one byte-stable descriptor", async () => {
    const route = await routeDescriptor();
    const encoded = await encodeA1BrokerRouteDescriptorV1(route);
    expect(await textDigest(encoded)).toBe("1lWaDWKJZ1Z9OEQBEYXAHkWnZv3mKh7QQvwnHzKTNqI");
    expect(await parseA1BrokerRouteDescriptorV1(route)).toEqual(route);
    await expect(
      parseA1BrokerRouteDescriptorV1({ ...route, routeToken: `${route.routeToken}x` }),
    ).rejects.toThrow(/ID\/token/);
    await expect(
      parseA1BrokerRouteDescriptorV1({ ...route, brokerOrigin: "https://broker.example/" }),
    ).rejects.toThrow(/canonical WHATWG origin/);
    await expect(parseA1BrokerRouteDescriptorV1({ ...route, logicalChatId: null })).rejects.toThrow(
      /logicalChatId/,
    );
    await expect(
      parseA1BrokerRouteDescriptorV1({ ...route, brokerBackendCapabilitiesDigest: ZERO_DIGEST }),
    ).rejects.toThrow(/capability digest/);
  });
});

describe("selected-A1 generation manifests and route opening", () => {
  it("locks the sealed manifest digest and rejects forks, aliases, and open-state digests", async () => {
    const route = await routeDescriptor();
    const manifestInput = {
      brokerRouteId: route.brokerRouteId,
      channelGeneration: 3,
      frameCount: 4_096,
      nextGeneration: 4,
      state: "sealed" as const,
    };
    const manifestDigest = await a1BrokerGenerationManifestDigest(manifestInput);
    expect(manifestDigest).toBe("MFRUEOGJKjZYuXDaI-YDPzMbAv_OKky-DknkC7Ve9Ok");
    const sealed = {
      schemaVersion: 1,
      ...manifestInput,
      manifestDigest,
    };
    expect(await parseBrokerChannelGenerationRecordV1(sealed)).toEqual(sealed);
    expect(await encodeBrokerChannelGenerationRecordV1(sealed)).toBe(
      '{"schemaVersion":1,"brokerRouteId":"rcr_bGFJPa2a6lLsYLdb1RIJhTgspOsaihYMe8hF-3erRzE","channelGeneration":3,"state":"sealed","frameCount":4096,"nextGeneration":4,"manifestDigest":"MFRUEOGJKjZYuXDaI-YDPzMbAv_OKky-DknkC7Ve9Ok"}',
    );
    await expect(
      parseBrokerChannelGenerationRecordV1({ ...sealed, nextGeneration: 5 }),
    ).rejects.toThrow(/nextGeneration/);
    await expect(
      parseBrokerChannelGenerationRecordV1({ ...sealed, frameCount: 4_095 }),
    ).rejects.toThrow(/manifestDigest/);
    await expect(
      parseBrokerChannelGenerationRecordV1({
        ...sealed,
        state: "open",
        frameCount: null,
        nextGeneration: null,
      }),
    ).rejects.toThrow(/null manifest/);
  });

  it("requires route creation to return the exact open generation-zero genesis", async () => {
    const route = await routeDescriptor();
    const receipt = {
      schemaVersion: 1,
      disposition: "created",
      route,
      genesis: {
        schemaVersion: 1,
        brokerRouteId: route.brokerRouteId,
        channelGeneration: 0,
        state: "open",
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
      },
      currentGeneration: {
        schemaVersion: 1,
        brokerRouteId: route.brokerRouteId,
        channelGeneration: 0,
        state: "open",
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
      },
      observedNextFrameIndex: 0,
    } as const;
    expect(await parseA1BrokerEnsureRouteReceiptV1(receipt)).toEqual(receipt);
    expect(await textDigest(await encodeA1BrokerEnsureRouteReceiptV1(receipt))).toBe(
      "SAa4PJSqE6L75TUqk_0DfXLgLqfobFlvMlWsfjlMkxU",
    );
    const existingNonempty = {
      ...receipt,
      disposition: "existing",
      observedNextFrameIndex: 1,
    } as const;
    expect((await parseA1BrokerEnsureRouteReceiptV1(existingNonempty)).observedNextFrameIndex).toBe(
      1,
    );
    await expect(
      parseA1BrokerEnsureRouteReceiptV1({ ...receipt, observedNextFrameIndex: 1 }),
    ).rejects.toThrow(/pristine open generation zero/);
    await expect(
      parseA1BrokerEnsureRouteReceiptV1({
        ...receipt,
        genesis: { ...receipt.genesis, channelGeneration: 1 },
      }),
    ).rejects.toThrow(/generation zero/);

    const mutable = {
      ...receipt,
      genesis: { ...receipt.genesis, channelGeneration: 0 as number },
      currentGeneration: { ...receipt.currentGeneration, channelGeneration: 0 as number },
    };
    const pending = parseA1BrokerEnsureRouteReceiptV1(mutable);
    mutable.genesis.channelGeneration = 9;
    mutable.currentGeneration.channelGeneration = 9;
    expect((await pending).genesis.channelGeneration).toBe(0);
  });
});

describe("selected-A1 publish, retry, and collision records", () => {
  it("strict-parses raw frame bytes, canonicalizes whitespace, and recomputes transport digest", async () => {
    const canonical = encodeA1EncryptedFrameV2(frame());
    const reordered = ` { ${canonical.slice(1, -1)} } `;
    const inspected = await parseA1BrokerCanonicalFrameV1(reordered);
    expect(inspected.canonicalFrame).toBe(canonical);
    expect(inspected.transportFrameDigest).toBe("Ujma5g9p-358qgAZ84pXkbWfn6-TwLP8-Yh96Tnf0is");
    await expect(parseA1BrokerCanonicalFrameV1(`${canonical}x`)).rejects.toThrow(/trailing bytes/);
    await expect(
      parseA1BrokerCanonicalFrameV1(" ".repeat(A1_BROKER_MAX_RAW_FRAME_BYTES + 1)),
    ).rejects.toThrow(/raw frame exceeds/);
    await expect(
      parseA1BrokerCanonicalFrameV1(
        encodeA1EncryptedFrameV2(frame({ parts: A1_BROKER_MAX_PARTS + 1 })),
      ),
    ).rejects.toThrow(/parts/);
  });

  it("treats the ciphertext cap as exclusive", async () => {
    await expect(
      parseA1BrokerCanonicalFrameV1(
        encodeA1EncryptedFrameV2(frame({ ct: new Uint8Array(A1_BROKER_CIPHERTEXT_LIMIT_BYTES) })),
      ),
    ).rejects.toThrow(/shorter than/);
    const eligible = await parseA1BrokerCanonicalFrameV1(
      encodeA1EncryptedFrameV2(frame({ ct: new Uint8Array(A1_BROKER_CIPHERTEXT_LIMIT_BYTES - 1) })),
    );
    expect(new TextEncoder().encode(eligible.canonicalFrame).byteLength).toBeLessThanOrEqual(
      A1_BROKER_MAX_RAW_FRAME_BYTES,
    );
  });

  it("locks exact-retry receipts and preserves first-vs-current collision evidence", async () => {
    const route = await routeDescriptor();
    const receipt = {
      schemaVersion: 1,
      outcome: "exact_retry",
      brokerRouteId: route.brokerRouteId,
      routeStoreInstanceId: STORE_ID,
      deliveryAttemptId: ATTEMPT_ID,
      part: 0,
      transportFrameDigest: ZERO_DIGEST,
      cursor: { version: 1, channelGeneration: 7, frameIndex: 12 },
    } as const;
    expect(parseA1BrokerPublishReceiptV1(receipt)).toEqual(receipt);
    expect(encodeA1BrokerPublishReceiptV1(receipt)).toBe(
      '{"schemaVersion":1,"outcome":"exact_retry","brokerRouteId":"rcr_bGFJPa2a6lLsYLdb1RIJhTgspOsaihYMe8hF-3erRzE","routeStoreInstanceId":"rbsi_UFFSU1RVVldYWVpbXF1eXw","deliveryAttemptId":"rda_QEFCQ0RFRkdISUpLTE1OTw","part":0,"transportFrameDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","cursor":{"version":1,"channelGeneration":7,"frameIndex":12}}',
    );
    const collision = {
      schemaVersion: 1,
      code: "transport_collision",
      brokerRouteId: route.brokerRouteId,
      routeStoreInstanceId: STORE_ID,
      deliveryAttemptId: ATTEMPT_ID,
      part: 0,
      originalCursor: receipt.cursor,
      originalTransportFrameDigest: ZERO_DIGEST,
      firstConflictingTransportFrameDigest: ONE_DIGEST,
      conflictingTransportFrameDigest: TWO_DIGEST,
    } as const;
    expect(parseA1BrokerTransportCollisionV1(collision)).toEqual(collision);
    expect(encodeA1BrokerTransportCollisionV1(collision)).toBe(
      '{"schemaVersion":1,"code":"transport_collision","brokerRouteId":"rcr_bGFJPa2a6lLsYLdb1RIJhTgspOsaihYMe8hF-3erRzE","routeStoreInstanceId":"rbsi_UFFSU1RVVldYWVpbXF1eXw","deliveryAttemptId":"rda_QEFCQ0RFRkdISUpLTE1OTw","part":0,"originalCursor":{"version":1,"channelGeneration":7,"frameIndex":12},"originalTransportFrameDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","firstConflictingTransportFrameDigest":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","conflictingTransportFrameDigest":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"}',
    );
    expect(() =>
      parseA1BrokerTransportCollisionV1({
        ...collision,
        conflictingTransportFrameDigest: ZERO_DIGEST,
      }),
    ).toThrow(/differ from the original/);
  });
});

describe("selected-A1 one-generation read pages", () => {
  it("locks an open live-tail page and rejects cursor gaps, metadata changes, and false tail claims", async () => {
    const route = await routeDescriptor();
    const item = await readFrame();
    const page = {
      schemaVersion: 1,
      brokerRouteId: route.brokerRouteId,
      routeStoreInstanceId: STORE_ID,
      requestedPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      generation: {
        schemaVersion: 1,
        brokerRouteId: route.brokerRouteId,
        channelGeneration: 0,
        state: "open",
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
      },
      observedNextFrameIndex: 1,
      frames: [item],
      nextPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 1 },
      atLiveTail: true,
    } as const;
    expect(await parseA1BrokerReadPageV1(page)).toEqual(page);
    expect(await textDigest(await encodeA1BrokerReadPageV1(page))).toBe(
      "BECYG1wpvjj1lHfloE2EwM6-dlJ7CDMOFqRc8JYrJrA",
    );
    await expect(
      parseA1BrokerReadPageV1({
        ...page,
        frames: [{ ...item, cursor: { ...item.cursor, frameIndex: 1 } }],
      }),
    ).rejects.toThrow(/contiguous/);
    await expect(parseA1BrokerReadPageV1({ ...page, atLiveTail: false })).rejects.toThrow(
      /atLiveTail/,
    );
    await expect(
      parseA1BrokerReadPageV1({
        ...page,
        frames: [{ ...item, transportFrameDigest: ONE_DIGEST }],
      }),
    ).rejects.toThrow(/metadata/);
    await expect(
      parseA1BrokerReadPageV1({
        ...page,
        frames: [{ ...item, canonicalFrame: ` ${item.canonicalFrame}` }],
      }),
    ).rejects.toThrow(/canonical compact/);
  });

  it("distinguishes a sampled open non-tail from sealed drain and empty-generation rollover", async () => {
    const route = await routeDescriptor();
    const item = await readFrame();
    const openNonTail = {
      schemaVersion: 1,
      brokerRouteId: route.brokerRouteId,
      routeStoreInstanceId: STORE_ID,
      requestedPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      generation: {
        schemaVersion: 1,
        brokerRouteId: route.brokerRouteId,
        channelGeneration: 0,
        state: "open",
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
      },
      observedNextFrameIndex: 2,
      frames: [item],
      nextPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 1 },
      atLiveTail: false,
    } as const;
    expect((await parseA1BrokerReadPageV1(openNonTail)).atLiveTail).toBe(false);

    const manifestDigest = await a1BrokerGenerationManifestDigest({
      brokerRouteId: route.brokerRouteId,
      channelGeneration: 0,
      frameCount: 1,
      nextGeneration: 1,
      state: "sealed",
    });
    const sealed = {
      ...openNonTail,
      generation: {
        ...openNonTail.generation,
        state: "sealed",
        frameCount: 1,
        nextGeneration: 1,
        manifestDigest,
      },
      observedNextFrameIndex: 1,
      nextPosition: { version: 1, channelGeneration: 1, nextFrameIndex: 0 },
    } as const;
    expect((await parseA1BrokerReadPageV1(sealed)).nextPosition).toEqual(sealed.nextPosition);

    const emptyDigest = await a1BrokerGenerationManifestDigest({
      brokerRouteId: route.brokerRouteId,
      channelGeneration: 0,
      frameCount: 0,
      nextGeneration: 1,
      state: "sealed",
    });
    const empty = {
      ...sealed,
      generation: { ...sealed.generation, frameCount: 0, manifestDigest: emptyDigest },
      observedNextFrameIndex: 0,
      frames: [],
    } as const;
    expect((await parseA1BrokerReadPageV1(empty)).nextPosition).toEqual(empty.nextPosition);
    await expect(parseA1BrokerReadPageV1({ ...sealed, observedNextFrameIndex: 0 })).rejects.toThrow(
      /immutable frame count/,
    );
  });

  it("allows one largest eligible frame within the page-byte bound and rejects oversized arrays", async () => {
    const route = await routeDescriptor();
    const inspected = await parseA1BrokerCanonicalFrameV1(
      encodeA1EncryptedFrameV2(frame({ ct: new Uint8Array(A1_BROKER_CIPHERTEXT_LIMIT_BYTES - 1) })),
    );
    const item = {
      schemaVersion: 1,
      cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
      deliveryAttemptId: ATTEMPT_ID,
      part: 0,
      transportFrameDigest: inspected.transportFrameDigest,
      canonicalFrame: inspected.canonicalFrame,
    } as const;
    const page = {
      schemaVersion: 1,
      brokerRouteId: route.brokerRouteId,
      routeStoreInstanceId: STORE_ID,
      requestedPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      generation: {
        schemaVersion: 1,
        brokerRouteId: route.brokerRouteId,
        channelGeneration: 0,
        state: "open",
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
      },
      observedNextFrameIndex: 1,
      frames: [item],
      nextPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 1 },
      atLiveTail: true,
    } as const;
    const encoded = await encodeA1BrokerReadPageV1(page);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
      A1_BROKER_MAX_READ_ENCODED_BYTES,
    );
    await expect(
      parseA1BrokerReadPageV1({
        ...page,
        observedNextFrameIndex: A1_BROKER_MAX_READ_FRAMES + 1,
        frames: Array.from({ length: A1_BROKER_MAX_READ_FRAMES + 1 }, () => item),
        nextPosition: {
          version: 1,
          channelGeneration: 0,
          nextFrameIndex: A1_BROKER_MAX_READ_FRAMES + 1,
        },
      }),
    ).rejects.toThrow(/exceeds 64 entries/);
  });
});
