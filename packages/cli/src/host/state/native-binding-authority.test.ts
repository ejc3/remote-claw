import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1SafeId } from "./ids.js";
import {
  nativeBindingCapabilitySnapshotId,
  nativeCapabilitySnapshotAttestationId,
  nativeListenerRegistrationAttestationId,
  nativeRuntimeIsolationAttestationId,
} from "./native-binding-authority.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

const runtimeId = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 1)}`);
const successorRuntimeId = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 2)}`);

describe("A1.8a1-E native-binding-authority identities", () => {
  it("locks the four canonical derivation vectors", async () => {
    const listenerInput = {
      runtimeId,
      nativeIncarnation: 2,
      runtimeOwnerKeyGeneration: 3,
    } as const;
    await expect(nativeListenerRegistrationAttestationId(listenerInput)).resolves.toBe(
      "nlra_oDrY2F591twB2-HQR6uLzNn8atsrfOv-NLbeRkm6UxY",
    );
    await expect(nativeRuntimeIsolationAttestationId(listenerInput)).resolves.toBe(
      "nria_zFHbjmy5ZJZCbfrlHeqfcI25_2cnAPfFELeuWEuEpAg",
    );
    const snapshotId = await nativeBindingCapabilitySnapshotId({
      attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
      capabilityGeneration: 4,
    });
    expect(snapshotId).toBe("nbcs_n2vbBczDljN8GFaxHTxmz60hGI6FTZ2D1xpCECprbt8");
    await expect(
      nativeCapabilitySnapshotAttestationId({ capabilitySnapshotId: snapshotId }),
    ).resolves.toBe("ncsa_dWrRTDNyliQvoQmLuNFBFw6chCYmaGVktKClFFhaJhA");
  });

  it("rejects malformed shapes and non-positive derivation coordinates", async () => {
    await expect(
      nativeListenerRegistrationAttestationId({
        runtimeId,
        nativeIncarnation: 0,
        runtimeOwnerKeyGeneration: 3,
      }),
    ).rejects.toThrow(/nativeIncarnation must be greater than zero/);
    await expect(
      nativeRuntimeIsolationAttestationId({
        runtimeId,
        nativeIncarnation: 2,
        runtimeOwnerKeyGeneration: -0,
      }),
    ).rejects.toThrow(/runtimeOwnerKeyGeneration must be a non-negative safe integer/);
    await expect(
      nativeBindingCapabilitySnapshotId({
        attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
        capabilityGeneration: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow(/non-negative safe integer/);
    await expect(
      nativeBindingCapabilitySnapshotId({
        attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
        capabilityGeneration: 1,
        extra: true,
      } as never),
    ).rejects.toThrow(/exactly the selected fields/);

    for (const nativeIncarnation of [-1, 1.5]) {
      await expect(
        nativeListenerRegistrationAttestationId({
          runtimeId,
          nativeIncarnation,
          runtimeOwnerKeyGeneration: 3,
        }),
      ).rejects.toThrow(/nativeIncarnation must be a non-negative safe integer/);
    }
    for (const capabilityGeneration of [-1, 1.5]) {
      await expect(
        nativeBindingCapabilitySnapshotId({
          attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
          capabilityGeneration,
        }),
      ).rejects.toThrow(/capabilityGeneration must be a non-negative safe integer/);
    }
  });

  it("rejects accessors and cross-namespace snapshot substitution", async () => {
    await expect(
      nativeListenerRegistrationAttestationId(
        Object.defineProperty({ nativeIncarnation: 2, runtimeOwnerKeyGeneration: 3 }, "runtimeId", {
          enumerable: true,
          get: () => runtimeId,
        }) as never,
      ),
    ).rejects.toThrow(/own data properties/);

    await expect(
      nativeCapabilitySnapshotAttestationId({
        capabilitySnapshotId: parseA1CanonicalId(
          "nativeRuntimeIsolationAttestation",
          `nria_${encoded(32, 8)}`,
        ),
      } as never),
    ).rejects.toThrow(/nbcs_/);
  });

  it("changes every committed coordinate", async () => {
    const base = { runtimeId, nativeIncarnation: 2, runtimeOwnerKeyGeneration: 3 } as const;
    const listener = await nativeListenerRegistrationAttestationId(base);
    await expect(
      nativeListenerRegistrationAttestationId({ ...base, runtimeId: successorRuntimeId }),
    ).resolves.not.toBe(listener);
    await expect(
      nativeListenerRegistrationAttestationId({ ...base, nativeIncarnation: 3 }),
    ).resolves.not.toBe(listener);
    await expect(
      nativeListenerRegistrationAttestationId({ ...base, runtimeOwnerKeyGeneration: 4 }),
    ).resolves.not.toBe(listener);

    const isolation = await nativeRuntimeIsolationAttestationId(base);
    await expect(
      nativeRuntimeIsolationAttestationId({ ...base, runtimeId: successorRuntimeId }),
    ).resolves.not.toBe(isolation);
    await expect(
      nativeRuntimeIsolationAttestationId({ ...base, nativeIncarnation: 3 }),
    ).resolves.not.toBe(isolation);
    await expect(
      nativeRuntimeIsolationAttestationId({ ...base, runtimeOwnerKeyGeneration: 4 }),
    ).resolves.not.toBe(isolation);

    const snapshot = await nativeBindingCapabilitySnapshotId({
      attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
      capabilityGeneration: 4,
    });
    await expect(
      nativeBindingCapabilitySnapshotId({
        attachmentLeaseId: parseA1SafeId("attachment-lease-2"),
        capabilityGeneration: 4,
      }),
    ).resolves.not.toBe(snapshot);
    await expect(
      nativeBindingCapabilitySnapshotId({
        attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
        capabilityGeneration: 5,
      }),
    ).resolves.not.toBe(snapshot);

    const successorSnapshot = await nativeBindingCapabilitySnapshotId({
      attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
      capabilityGeneration: 5,
    });
    const attestation = await nativeCapabilitySnapshotAttestationId({
      capabilitySnapshotId: snapshot,
    });
    await expect(
      nativeCapabilitySnapshotAttestationId({ capabilitySnapshotId: successorSnapshot }),
    ).resolves.not.toBe(attestation);
  });
});
