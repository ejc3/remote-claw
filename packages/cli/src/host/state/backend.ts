import { base64urlEncode, CanonicalWriter, sha256 } from "@remote-claw/clawsec";
import { type A1Digest, parseA1Digest } from "./ids.js";
import { frozen, parseExactRecord, parseLiteral } from "./validation.js";

export const BROKER_BACKEND_CAPABILITIES_SCHEMA_ID =
  "remote-claw/broker-backend-capabilities/v1" as const;

export interface BrokerBackendCapabilitiesV1 {
  readonly schemaVersion: 1;
  readonly protocol: "remote-claw-broker-a1";
  readonly durableCiphertext: true;
  readonly routeWideDeliveryAttemptUniqueness: true;
  readonly brokerRecomputesTransportDigest: true;
  readonly exactRetryReturnsOriginalCursor: true;
  readonly generationManifests: true;
  readonly immutableCollisionTombstones: true;
}

const CAPABILITY_KEYS = [
  "schemaVersion",
  "protocol",
  "durableCiphertext",
  "routeWideDeliveryAttemptUniqueness",
  "brokerRecomputesTransportDigest",
  "exactRetryReturnsOriginalCursor",
  "generationManifests",
  "immutableCollisionTombstones",
] as const;

export function parseBrokerBackendCapabilitiesV1(value: unknown): BrokerBackendCapabilitiesV1 {
  const row = parseExactRecord(value, CAPABILITY_KEYS, "brokerBackendCapabilities");
  return frozen({
    schemaVersion: parseLiteral(row.schemaVersion, 1, "brokerBackendCapabilities.schemaVersion"),
    protocol: parseLiteral(
      row.protocol,
      "remote-claw-broker-a1",
      "brokerBackendCapabilities.protocol",
    ),
    durableCiphertext: parseLiteral(
      row.durableCiphertext,
      true,
      "brokerBackendCapabilities.durableCiphertext",
    ),
    routeWideDeliveryAttemptUniqueness: parseLiteral(
      row.routeWideDeliveryAttemptUniqueness,
      true,
      "brokerBackendCapabilities.routeWideDeliveryAttemptUniqueness",
    ),
    brokerRecomputesTransportDigest: parseLiteral(
      row.brokerRecomputesTransportDigest,
      true,
      "brokerBackendCapabilities.brokerRecomputesTransportDigest",
    ),
    exactRetryReturnsOriginalCursor: parseLiteral(
      row.exactRetryReturnsOriginalCursor,
      true,
      "brokerBackendCapabilities.exactRetryReturnsOriginalCursor",
    ),
    generationManifests: parseLiteral(
      row.generationManifests,
      true,
      "brokerBackendCapabilities.generationManifests",
    ),
    immutableCollisionTombstones: parseLiteral(
      row.immutableCollisionTombstones,
      true,
      "brokerBackendCapabilities.immutableCollisionTombstones",
    ),
  });
}

/**
 * Canonical capability vector pinned by every selected-A1 broker route.
 *
 * Each required boolean occupies its fixed field position as `uint(1)`. There is no representation
 * for a partial or false vector under schema version 1.
 */
export async function brokerBackendCapabilitiesDigest(
  value: BrokerBackendCapabilitiesV1,
): Promise<A1Digest> {
  const parsed = parseBrokerBackendCapabilitiesV1(value);
  const writer = new CanonicalWriter();
  writer.str(BROKER_BACKEND_CAPABILITIES_SCHEMA_ID);
  writer.uint(parsed.schemaVersion);
  writer.str(parsed.protocol);
  writer.uint(1); // durableCiphertext
  writer.uint(1); // routeWideDeliveryAttemptUniqueness
  writer.uint(1); // brokerRecomputesTransportDigest
  writer.uint(1); // exactRetryReturnsOriginalCursor
  writer.uint(1); // generationManifests
  writer.uint(1); // immutableCollisionTombstones
  return parseA1Digest(base64urlEncode(await sha256(writer.finish())));
}
