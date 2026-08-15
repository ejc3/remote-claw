import {
  base64urlEncode,
  deriveA1BrokerRouteId,
  deriveA1ChatToken,
  deriveA1ScopeToken,
  deriveA1ServerControlToken,
} from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  canonicalBrokerBackendCapabilitiesV1,
  REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
} from "./backend.js";
import {
  deriveBrokerBackendCapabilityPinId,
  deriveBrokerRouteId,
  deriveBrokerRouteToken,
  parseBrokerOrigin,
  parseBrokerRouteStoreInstanceId,
  parseConfirmedBrokerRouteOpenReceiptV1,
  parseRequiredBrokerCapabilitiesArtifact,
  syncBrokerBackendCapabilitiesDigestV1,
} from "./broker-route.js";
import { parseA1CanonicalId } from "./ids.js";

const MACHINE_IDENTITY_ID = "01".repeat(16);
const IDENTITY_BYTES = new Uint8Array(Buffer.from(MACHINE_IDENTITY_ID, "hex"));
const SERVER_ID = parseA1CanonicalId(
  "collaborationServer",
  `rcs_${base64urlEncode(new Uint8Array(16).fill(2))}`,
);
const CHAT_ID = parseA1CanonicalId(
  "logicalChat",
  `rcl_${base64urlEncode(new Uint8Array(16).fill(3))}`,
);
const STORE_ID = parseBrokerRouteStoreInstanceId(
  `rbsi_${base64urlEncode(new Uint8Array(16).fill(4))}`,
);

describe("dormant A1 broker-route contracts", () => {
  it("derives the exact clawsec route IDs and tokens for all three route scopes", async () => {
    for (const route of [
      { routeKind: "scope_bus" as const, logicalChatId: null },
      { routeKind: "server_control" as const, logicalChatId: null },
      { routeKind: "chat" as const, logicalChatId: CHAT_ID },
    ]) {
      expect(
        deriveBrokerRouteId(MACHINE_IDENTITY_ID, SERVER_ID, route.routeKind, route.logicalChatId),
      ).toBe(
        await deriveA1BrokerRouteId(
          route.routeKind === "chat"
            ? {
                routeKind: "chat",
                identityId: IDENTITY_BYTES,
                collaborationServerId: SERVER_ID,
                logicalChatId: CHAT_ID,
              }
            : {
                routeKind: route.routeKind,
                identityId: IDENTITY_BYTES,
                collaborationServerId: SERVER_ID,
                logicalChatId: null,
              },
        ),
      );
      const expectedToken =
        route.routeKind === "scope_bus"
          ? await deriveA1ScopeToken(IDENTITY_BYTES, SERVER_ID)
          : route.routeKind === "server_control"
            ? await deriveA1ServerControlToken(IDENTITY_BYTES, SERVER_ID)
            : await deriveA1ChatToken(IDENTITY_BYTES, SERVER_ID, CHAT_ID);
      expect(
        deriveBrokerRouteToken(
          MACHINE_IDENTITY_ID,
          SERVER_ID,
          route.routeKind,
          route.logicalChatId,
        ),
      ).toBe(expectedToken);
    }
  });

  it("pins the exact required capability bytes, digest, origin, selector, and ID", () => {
    const bytes = canonicalBrokerBackendCapabilitiesV1(REQUIRED_BROKER_BACKEND_CAPABILITIES_V1);
    expect(parseRequiredBrokerCapabilitiesArtifact(bytes)).toEqual(
      REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
    );
    const digest = syncBrokerBackendCapabilitiesDigestV1(REQUIRED_BROKER_BACKEND_CAPABILITIES_V1);
    expect(digest).toBe("pxq9w0eeR1rKMUyVw5p5Sgl6VU1jdEHAPYlrS93Cbdo");
    expect(deriveBrokerBackendCapabilityPinId("https://broker.example", "sqlite", digest)).toBe(
      "rbcp_lB2Zw92bjxhnKnj_IadmjVRxtTefe72_eiBk-saEmkk",
    );
    const changed = bytes.slice();
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    expect(() => parseRequiredBrokerCapabilitiesArtifact(changed)).toThrow(/canonical required/);
  });

  it("accepts only canonical WHATWG HTTP(S) origins and canonical store IDs", () => {
    expect(parseBrokerOrigin("https://broker.example")).toBe("https://broker.example");
    for (const origin of [
      "https://broker.example/",
      "HTTPS://broker.example",
      "https://broker.example:443",
      "https://user@broker.example",
      "ftp://broker.example",
      "https://broker.example/path",
    ]) {
      expect(() => parseBrokerOrigin(origin), origin).toThrow(/canonical HTTP\(S\) origin/);
    }
    expect(parseBrokerRouteStoreInstanceId(STORE_ID)).toBe(STORE_ID);
    expect(() =>
      parseBrokerRouteStoreInstanceId(`rbsi_${base64urlEncode(new Uint8Array(15))}`),
    ).toThrow(/canonical selected-A1 identifier/);
  });

  it("accepts only an exact created/existing empty open-genesis receipt", () => {
    const digest = syncBrokerBackendCapabilitiesDigestV1(REQUIRED_BROKER_BACKEND_CAPABILITIES_V1);
    const brokerRouteId = deriveBrokerRouteId(MACHINE_IDENTITY_ID, SERVER_ID, "chat", CHAT_ID);
    const receipt = {
      schemaVersion: 1 as const,
      disposition: "created" as const,
      route: {
        schemaVersion: 1 as const,
        brokerOrigin: "https://broker.example",
        backendSelector: "sqlite" as const,
        routeStoreInstanceId: STORE_ID,
        identityId: MACHINE_IDENTITY_ID,
        collaborationServerId: SERVER_ID,
        routeKind: "chat" as const,
        logicalChatId: CHAT_ID,
        brokerRouteId,
        routeToken: deriveBrokerRouteToken(MACHINE_IDENTITY_ID, SERVER_ID, "chat", CHAT_ID),
        brokerBackendCapabilitiesDigest: digest,
      },
      genesis: {
        schemaVersion: 1 as const,
        brokerRouteId,
        channelGeneration: 0 as const,
        state: "open" as const,
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
      },
      currentGeneration: {
        schemaVersion: 1 as const,
        brokerRouteId,
        channelGeneration: 0 as const,
        state: "open" as const,
        frameCount: null,
        nextGeneration: null,
        manifestDigest: null,
      },
      observedNextFrameIndex: 0 as const,
    };
    expect(parseConfirmedBrokerRouteOpenReceiptV1(receipt)).toEqual(receipt);
    expect(
      parseConfirmedBrokerRouteOpenReceiptV1({
        ...receipt,
        disposition: "existing",
      }).disposition,
    ).toBe("existing");
    expect(() =>
      parseConfirmedBrokerRouteOpenReceiptV1({
        ...receipt,
        genesis: { ...receipt.genesis, frameCount: 0 },
      }),
    ).toThrow(/frameCount must equal null/);
    expect(() =>
      parseConfirmedBrokerRouteOpenReceiptV1({
        ...receipt,
        observedNextFrameIndex: 1,
      }),
    ).toThrow(/observedNextFrameIndex must equal 0/);
    expect(() =>
      parseConfirmedBrokerRouteOpenReceiptV1({
        ...receipt,
        route: { ...receipt.route, extra: true },
      }),
    ).toThrow(/exactly the selected fields/);
  });
});
