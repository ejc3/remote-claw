import { describe, expect, it } from "vitest";
import {
  type BrokerBackendCapabilitiesV1,
  brokerBackendCapabilitiesDigest,
  parseBrokerBackendCapabilitiesV1,
} from "./backend.js";

const capabilities = {
  schemaVersion: 1,
  protocol: "remote-claw-broker-a1",
  durableCiphertext: true,
  routeWideDeliveryAttemptUniqueness: true,
  brokerRecomputesTransportDigest: true,
  exactRetryReturnsOriginalCursor: true,
  generationManifests: true,
  immutableCollisionTombstones: true,
} satisfies BrokerBackendCapabilitiesV1;

describe("selected A1 broker capability vector", () => {
  it("accepts, freezes, and canonically hashes the exact required vector", async () => {
    const parsed = parseBrokerBackendCapabilitiesV1(capabilities);

    expect(parsed).toEqual(capabilities);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(await brokerBackendCapabilitiesDigest(parsed)).toBe(
      "pxq9w0eeR1rKMUyVw5p5Sgl6VU1jdEHAPYlrS93Cbdo",
    );
  });

  it("is independent of input property insertion order", async () => {
    const reordered = {
      immutableCollisionTombstones: true,
      generationManifests: true,
      exactRetryReturnsOriginalCursor: true,
      brokerRecomputesTransportDigest: true,
      routeWideDeliveryAttemptUniqueness: true,
      durableCiphertext: true,
      protocol: "remote-claw-broker-a1",
      schemaVersion: 1,
    } satisfies BrokerBackendCapabilitiesV1;

    expect(await brokerBackendCapabilitiesDigest(reordered)).toBe(
      await brokerBackendCapabilitiesDigest(capabilities),
    );
  });

  it("rejects partial, downgraded, extended, and non-plain vectors", () => {
    const { generationManifests: _, ...partial } = capabilities;
    expect(() => parseBrokerBackendCapabilitiesV1(partial)).toThrow(/exactly the selected fields/);
    expect(() =>
      parseBrokerBackendCapabilitiesV1({
        ...capabilities,
        durableCiphertext: false,
      }),
    ).toThrow(/durableCiphertext/);
    expect(() =>
      parseBrokerBackendCapabilitiesV1({
        ...capabilities,
        futureCapability: true,
      }),
    ).toThrow(/exactly the selected fields/);
    expect(() =>
      parseBrokerBackendCapabilitiesV1(
        Object.assign(Object.create({ inherited: true }), capabilities),
      ),
    ).toThrow(/plain object/);
  });

  it("refuses to hash a vector that bypassed static typing", async () => {
    await expect(
      brokerBackendCapabilitiesDigest({
        ...capabilities,
        immutableCollisionTombstones: false,
      } as unknown as BrokerBackendCapabilitiesV1),
    ).rejects.toThrow(/immutableCollisionTombstones/);
  });
});
