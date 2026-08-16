import { base64urlEncode, CanonicalWriter, sha256 } from "@remote-claw/clawsec";
import {
  type A1CanonicalId,
  type A1SafeId,
  type NativeBindingCapabilitySnapshotId,
  type NativeCapabilitySnapshotAttestationId,
  type NativeListenerRegistrationAttestationId,
  type NativeRuntimeId,
  type NativeRuntimeIsolationAttestationId,
  parseA1CanonicalId,
  parseA1SafeId,
} from "./ids.js";
import { parseExactRecord, parsePositiveSafeInteger } from "./validation.js";

export interface NativeRuntimeAttestationIdInput {
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly runtimeOwnerKeyGeneration: number;
}

export interface NativeBindingCapabilitySnapshotIdInput {
  readonly attachmentLeaseId: A1SafeId;
  readonly capabilityGeneration: number;
}

export interface NativeCapabilitySnapshotAttestationIdInput {
  readonly capabilitySnapshotId: NativeBindingCapabilitySnapshotId;
}

type DerivedNativeBindingAuthorityIdKind =
  | "nativeListenerRegistrationAttestation"
  | "nativeRuntimeIsolationAttestation"
  | "nativeBindingCapabilitySnapshot"
  | "nativeCapabilitySnapshotAttestation";

async function derivedId<K extends DerivedNativeBindingAuthorityIdKind>(
  kind: K,
  writer: CanonicalWriter,
): Promise<A1CanonicalId<K>> {
  const spec = {
    nativeListenerRegistrationAttestation: "nlra_",
    nativeRuntimeIsolationAttestation: "nria_",
    nativeBindingCapabilitySnapshot: "nbcs_",
    nativeCapabilitySnapshotAttestation: "ncsa_",
  } as const;
  return parseA1CanonicalId(kind, `${spec[kind]}${base64urlEncode(await sha256(writer.finish()))}`);
}

function parseRuntimeAttestationIdInput(
  value: NativeRuntimeAttestationIdInput,
  field: string,
): NativeRuntimeAttestationIdInput {
  const row = parseExactRecord(
    value,
    ["runtimeId", "nativeIncarnation", "runtimeOwnerKeyGeneration"],
    field,
  );
  return Object.freeze({
    runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId, `${field}.runtimeId`),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      `${field}.nativeIncarnation`,
    ),
    runtimeOwnerKeyGeneration: parsePositiveSafeInteger(
      row.runtimeOwnerKeyGeneration,
      `${field}.runtimeOwnerKeyGeneration`,
    ),
  });
}

export async function nativeListenerRegistrationAttestationId(
  input: NativeRuntimeAttestationIdInput,
): Promise<NativeListenerRegistrationAttestationId> {
  const parsed = parseRuntimeAttestationIdInput(input, "nativeListenerRegistrationAttestationId");
  const writer = new CanonicalWriter();
  writer.str("remote-claw/native-listener-registration-attestation-id/v1");
  writer.str(parsed.runtimeId);
  writer.uint(parsed.nativeIncarnation);
  writer.uint(parsed.runtimeOwnerKeyGeneration);
  return derivedId("nativeListenerRegistrationAttestation", writer);
}

export async function nativeRuntimeIsolationAttestationId(
  input: NativeRuntimeAttestationIdInput,
): Promise<NativeRuntimeIsolationAttestationId> {
  const parsed = parseRuntimeAttestationIdInput(input, "nativeRuntimeIsolationAttestationId");
  const writer = new CanonicalWriter();
  writer.str("remote-claw/native-runtime-isolation-attestation-id/v1");
  writer.str(parsed.runtimeId);
  writer.uint(parsed.nativeIncarnation);
  writer.uint(parsed.runtimeOwnerKeyGeneration);
  return derivedId("nativeRuntimeIsolationAttestation", writer);
}

export async function nativeBindingCapabilitySnapshotId(
  input: NativeBindingCapabilitySnapshotIdInput,
): Promise<NativeBindingCapabilitySnapshotId> {
  const row = parseExactRecord(
    input,
    ["attachmentLeaseId", "capabilityGeneration"],
    "nativeBindingCapabilitySnapshotId",
  );
  const attachmentLeaseId = parseA1SafeId(
    row.attachmentLeaseId,
    "nativeBindingCapabilitySnapshotId.attachmentLeaseId",
  );
  const capabilityGeneration = parsePositiveSafeInteger(
    row.capabilityGeneration,
    "nativeBindingCapabilitySnapshotId.capabilityGeneration",
  );
  const writer = new CanonicalWriter();
  writer.str("remote-claw/native-binding-capability-snapshot-id/v1");
  writer.str(attachmentLeaseId);
  writer.uint(capabilityGeneration);
  return derivedId("nativeBindingCapabilitySnapshot", writer);
}

export async function nativeCapabilitySnapshotAttestationId(
  input: NativeCapabilitySnapshotAttestationIdInput,
): Promise<NativeCapabilitySnapshotAttestationId> {
  const row = parseExactRecord(
    input,
    ["capabilitySnapshotId"],
    "nativeCapabilitySnapshotAttestationId",
  );
  const capabilitySnapshotId = parseA1CanonicalId(
    "nativeBindingCapabilitySnapshot",
    row.capabilitySnapshotId,
    "nativeCapabilitySnapshotAttestationId.capabilitySnapshotId",
  );
  const writer = new CanonicalWriter();
  writer.str("remote-claw/native-capability-snapshot-attestation-id/v1");
  writer.str(capabilitySnapshotId);
  return derivedId("nativeCapabilitySnapshotAttestation", writer);
}
