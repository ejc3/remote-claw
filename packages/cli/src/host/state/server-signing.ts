import { createHash } from "node:crypto";
import type { ServerScopeCertificateRecord } from "@remote-claw/clawsec";
import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  canonicalByteSnapshot,
} from "@remote-claw/clawsec";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type Ed25519PublicKey,
  type Ed25519Signature,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseEd25519Signature,
  parseMachineIdentityId,
} from "./ids.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseLiteral,
  parseNonNegativeSafeInteger,
  parseNullable,
  parsePositiveSafeInteger,
  reject,
} from "./validation.js";

export const SERVER_KEY_WRAP_SCHEMA_ID =
  "remote-claw/server-identity-key-wrap/aes-256-gcm/v1" as const;
export const SERVER_SCOPE_CERTIFICATE_SCHEMA_ID =
  "remote-claw/server-scope-certificate/v1" as const;
export const SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID =
  "remote-claw/server-signer-bootstrap-intent/v1" as const;
export const SERVER_IDENTITY_KEY_ID_DOMAIN = "remote-claw/server-identity-key-id/v1" as const;

/** Pure canonical server-identity key ID derivation shared by custody and snapshot validation. */
export function deriveServerIdentityKeyId(
  machineIdentityIdInput: string,
  collaborationServerIdInput: CollaborationServerId,
  generationInput: number,
  publicKeyInput: Uint8Array,
): A1SafeId {
  const machineIdentityId = parseMachineIdentityId(machineIdentityIdInput);
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    collaborationServerIdInput,
  );
  const generation = parsePositiveSafeInteger(generationInput, "serverIdentityKey.generation");
  let publicKey: Uint8Array;
  try {
    publicKey = canonicalByteSnapshot(publicKeyInput);
  } catch {
    reject("serverIdentityKey.publicKey", "must contain exactly 32 bytes");
  }
  if (publicKey.byteLength !== 32) {
    publicKey.fill(0);
    reject("serverIdentityKey.publicKey", "must contain exactly 32 bytes");
  }
  let preimage: Uint8Array | undefined;
  try {
    const writer = new CanonicalWriter();
    writer.str(SERVER_IDENTITY_KEY_ID_DOMAIN);
    writer.bytes(Buffer.from(machineIdentityId, "hex"));
    writer.str(collaborationServerId);
    writer.uint(generation);
    writer.bytes(publicKey);
    preimage = writer.finish();
    return parseA1SafeId(`sik_${base64urlEncode(createHash("sha256").update(preimage).digest())}`);
  } finally {
    preimage?.fill(0);
    publicKey.fill(0);
  }
}

export interface ServerSignerBootstrapIntentV1 {
  readonly schemaVersion: 1;
  readonly canonicalPayloadSchemaId: typeof SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID;
  readonly machineIdentityId: string;
  readonly collaborationServerId: CollaborationServerId;
  readonly bootstrapSigningLeaseId: A1SafeId;
  readonly purpose: "initial_pair";
  readonly expectedPriorScopeCertificateId: null;
  readonly proposedIdentityKeyId: A1SafeId;
  readonly proposedKeyGeneration: 1;
  readonly proposedKeyAlgorithm: "Ed25519";
  readonly proposedPublicKey: Ed25519PublicKey;
  readonly proposedScopeCertificateId: A1SafeId;
  readonly signingKeyRef: ProtectedHandleId;
  readonly preparedAtMs: number;
}

export const SERVER_SIGNATURE_PURPOSES = Object.freeze([
  "scope_certificate",
  "onboarding_keys",
  "host_output",
  "scope_bus_checkpoint",
  "topology_path_hop",
  "server_rooted_topology",
  "edge_install_receipt",
  "edge_live_handshake",
  "event_lineage_hop",
  "collaboration_command_result",
  "nested_management_lineage_hop",
  "nested_management_live_handshake",
  "nested_management_transport_attestation",
  "nested_management_capability_continuation",
  "nested_positive_never_started_attestation",
  "nested_target_ready_attestation",
  "nested_chat_edge_capability_continuation",
  "historical_reattestation",
] as const);

export type ServerSignaturePurpose = (typeof SERVER_SIGNATURE_PURPOSES)[number];

export const SERVER_SIGNATURE_SCHEMAS = Object.freeze({
  scope_certificate: SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
  onboarding_keys: "remote-claw/viewer-onboarding-keys/v1",
  host_output: "remote-claw/a1/host-output-signature/v1",
  scope_bus_checkpoint: "remote-claw/a1/scope-bus-checkpoint/v1",
  topology_path_hop: "remote-claw/topology-path-hop/v1",
  server_rooted_topology: "remote-claw/server-rooted-topology-certificate/v1",
  edge_install_receipt: "remote-claw/inward-edge-install-receipt/v1",
  edge_live_handshake: "remote-claw/inward-edge-live-handshake/v1",
  event_lineage_hop: "remote-claw/event-lineage-hop/v1",
  collaboration_command_result: "remote-claw/collaboration-command-result/v1",
  nested_management_lineage_hop: "remote-claw/nested-management-lineage-hop/v1",
  nested_management_live_handshake: "remote-claw/nested-management-live-handshake/v1",
  nested_management_transport_attestation: "remote-claw/nested-management-transport-attestation/v1",
  nested_management_capability_continuation:
    "remote-claw/nested-management-capability-continuation/v1",
  nested_positive_never_started_attestation:
    "remote-claw/nested-positive-never-started-attestation/v1",
  nested_target_ready_attestation: "remote-claw/nested-target-ready-attestation/v1",
  nested_chat_edge_capability_continuation:
    "remote-claw/nested-chat-edge-capability-continuation/v1",
  historical_reattestation: "remote-claw/historical-record-reattestation/v1",
} as const satisfies Readonly<Record<ServerSignaturePurpose, string>>);

export type ServerSignatureSchemaId = (typeof SERVER_SIGNATURE_SCHEMAS)[ServerSignaturePurpose];

export interface ServerIdentityKeyRecord {
  readonly collaborationServerId: CollaborationServerId;
  readonly identityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly algorithm: "Ed25519";
  readonly publicKey: Ed25519PublicKey;
  readonly signingKeyRef: ProtectedHandleId;
  readonly introducedByScopeCertificateId: A1SafeId | null;
  readonly trustEvidenceRef: ProtectedHandleId;
  readonly trustEvidenceDigest: A1Digest;
  readonly validFromMs: number;
  readonly state: "proposed" | "current" | "retired" | "revoked";
}

export interface ServerIdentityPrivateKeyEnvelopeRecord {
  readonly signingKeyRef: ProtectedHandleId;
  readonly collaborationServerId: CollaborationServerId;
  readonly identityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly custodyBackend: "owned-file";
  readonly wrappingSchemaId: typeof SERVER_KEY_WRAP_SCHEMA_ID;
  readonly wrapNonce: ProtectedByteSnapshot;
  readonly wrappedPkcs8: ProtectedByteSnapshot;
  readonly authTag: ProtectedByteSnapshot;
  readonly pkcs8Digest: A1Digest;
  readonly createdAtMs: number;
  readonly destroyedAtMs: number | null;
  readonly state: "current" | "destroyed";
}

export interface ServerScopeCertificateStatusRecord {
  readonly collaborationServerId: CollaborationServerId;
  readonly scopeCertificateId: A1SafeId;
  readonly state: "current" | "retired" | "revoked";
  readonly acceptSignaturesThroughSequence: number | null;
  readonly changedAtMs: number;
  readonly changeEvidenceRef: A1SafeId;
  readonly changeEvidenceDigest: A1Digest;
}

export interface ServerBootstrapSigningLeaseRecord {
  readonly bootstrapSigningLeaseId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly purpose: "initial_pair" | "explicit_repair";
  readonly operatorIntentEvidenceRef: ProtectedHandleId;
  readonly operatorIntentEvidenceDigest: A1Digest;
  readonly expectedPriorScopeCertificateId: A1SafeId | null;
  readonly proposedIdentityKeyId: A1SafeId;
  readonly proposedKeyGeneration: number;
  readonly proposedScopeCertificateId: A1SafeId;
  readonly signingKeyRef: ProtectedHandleId;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly fencingToken: number;
  readonly preparedAtMs: number;
  readonly signedAtMs: number | null;
  readonly installedAtMs: number | null;
  readonly closedAtMs: number | null;
  readonly state: "prepared" | "signed" | "installed" | "closed";
}

export interface ServerSigningLeaseRecord {
  readonly signingLeaseId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly identityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly scopeCertificateId: A1SafeId;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly fencingToken: number;
  readonly acquiredAtMs: number;
  readonly drainingAtMs: number | null;
  readonly supersededAtMs: number | null;
  readonly closedAtMs: number | null;
  readonly state: "current" | "draining" | "superseded" | "closed";
}

export interface ServerSignatureReservationRecord {
  readonly collaborationServerId: CollaborationServerId;
  readonly signerSequence: number;
  readonly signingLeaseId: A1SafeId;
  readonly signingLeaseKind: "current" | "bootstrap";
  readonly purpose: ServerSignaturePurpose;
  readonly canonicalPayloadSchemaId: ServerSignatureSchemaId | null;
  readonly canonicalPayloadRef: ProtectedHandleId | null;
  readonly canonicalPayloadDigest: A1Digest | null;
  readonly signedRecordDigest: A1Digest | null;
  readonly signature: Ed25519Signature | null;
  readonly signedArtifactType: A1SafeId | null;
  readonly signedArtifactId: A1SafeId | null;
  readonly reservedAtMs: number;
  readonly boundAtMs: number | null;
  readonly signedAtMs: number | null;
  readonly abortedAtMs: number | null;
  readonly state: "reserved" | "bound" | "signed" | "aborted";
}

/** This row is itself the dense, append-only per-server signing-acceptance journal. */
export interface ServerSignedRecordAcceptanceRecord {
  readonly collaborationServerId: CollaborationServerId;
  readonly acceptedAtJournalSeq: number;
  readonly signedRecordDigest: A1Digest;
  readonly signerIdentityKeyId: A1SafeId;
  readonly signerKeyGeneration: number;
  readonly signerScopeCertificateId: A1SafeId;
  readonly signerSequence: number;
  readonly acceptedAtMs: number;
  readonly historicalReattestationId: A1SafeId | null;
}

export interface ServerSigningInventory {
  readonly identityKeys: readonly ServerIdentityKeyRecord[];
  readonly privateKeyEnvelopes: readonly ServerIdentityPrivateKeyEnvelopeRecord[];
  readonly scopeCertificates: readonly ServerScopeCertificateRecord[];
  readonly certificateStatuses: readonly ServerScopeCertificateStatusRecord[];
  readonly bootstrapLeases: readonly ServerBootstrapSigningLeaseRecord[];
  readonly signingLeases: readonly ServerSigningLeaseRecord[];
  readonly reservations: readonly ServerSignatureReservationRecord[];
  readonly acceptances: readonly ServerSignedRecordAcceptanceRecord[];
}

function snapshot(value: unknown, length: number | null, field: string): ProtectedByteSnapshot {
  if (
    !(value instanceof ProtectedByteSnapshot) ||
    (length !== null && value.byteLength !== length)
  ) {
    reject(
      field,
      `${field} must be a protected byte snapshot${length === null ? "" : ` of ${length} bytes`}`,
    );
  }
  return value;
}

function serverId(value: unknown, field: string): CollaborationServerId {
  return parseA1CanonicalId("collaborationServer", value, field);
}

function coordinatorLeaseId(value: unknown, field: string): CoordinatorLeaseId {
  return parseA1CanonicalId("coordinatorLease", value, field);
}

function protectedHandleId(value: unknown, field: string): ProtectedHandleId {
  return parseA1CanonicalId("protectedHandle", value, field);
}

const SERVER_SIGNER_BOOTSTRAP_INTENT_KEYS = [
  "schemaVersion",
  "canonicalPayloadSchemaId",
  "machineIdentityId",
  "collaborationServerId",
  "bootstrapSigningLeaseId",
  "purpose",
  "expectedPriorScopeCertificateId",
  "proposedIdentityKeyId",
  "proposedKeyGeneration",
  "proposedKeyAlgorithm",
  "proposedPublicKey",
  "proposedScopeCertificateId",
  "signingKeyRef",
  "preparedAtMs",
] as const;

export function parseServerSignerBootstrapIntentV1(value: unknown): ServerSignerBootstrapIntentV1 {
  const row = parseExactRecord(
    value,
    SERVER_SIGNER_BOOTSTRAP_INTENT_KEYS,
    "serverSignerBootstrapIntent",
  );
  if (row.expectedPriorScopeCertificateId !== null) {
    reject(
      "serverSignerBootstrapIntent.expectedPriorScopeCertificateId",
      "initial pairing must not name a predecessor certificate",
    );
  }
  return frozen({
    schemaVersion: parseLiteral(row.schemaVersion, 1, "serverSignerBootstrapIntent.schemaVersion"),
    canonicalPayloadSchemaId: parseLiteral(
      row.canonicalPayloadSchemaId,
      SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
      "serverSignerBootstrapIntent.canonicalPayloadSchemaId",
    ),
    machineIdentityId: parseMachineIdentityId(
      row.machineIdentityId,
      "serverSignerBootstrapIntent.machineIdentityId",
    ),
    collaborationServerId: serverId(
      row.collaborationServerId,
      "serverSignerBootstrapIntent.collaborationServerId",
    ),
    bootstrapSigningLeaseId: parseA1SafeId(
      row.bootstrapSigningLeaseId,
      "serverSignerBootstrapIntent.bootstrapSigningLeaseId",
    ),
    purpose: parseLiteral(row.purpose, "initial_pair", "serverSignerBootstrapIntent.purpose"),
    expectedPriorScopeCertificateId: null,
    proposedIdentityKeyId: parseA1SafeId(
      row.proposedIdentityKeyId,
      "serverSignerBootstrapIntent.proposedIdentityKeyId",
    ),
    proposedKeyGeneration: parseLiteral(
      row.proposedKeyGeneration,
      1,
      "serverSignerBootstrapIntent.proposedKeyGeneration",
    ),
    proposedKeyAlgorithm: parseLiteral(
      row.proposedKeyAlgorithm,
      "Ed25519",
      "serverSignerBootstrapIntent.proposedKeyAlgorithm",
    ),
    proposedPublicKey: parseEd25519PublicKey(
      row.proposedPublicKey,
      "serverSignerBootstrapIntent.proposedPublicKey",
    ),
    proposedScopeCertificateId: parseA1SafeId(
      row.proposedScopeCertificateId,
      "serverSignerBootstrapIntent.proposedScopeCertificateId",
    ),
    signingKeyRef: protectedHandleId(
      row.signingKeyRef,
      "serverSignerBootstrapIntent.signingKeyRef",
    ),
    preparedAtMs: parseNonNegativeSafeInteger(
      row.preparedAtMs,
      "serverSignerBootstrapIntent.preparedAtMs",
    ),
  });
}

export function encodeServerSignerBootstrapIntentV1(value: unknown): Uint8Array {
  const intent = parseServerSignerBootstrapIntentV1(value);
  const publicKey = base64urlDecode(intent.proposedPublicKey);
  try {
    const writer = new CanonicalWriter();
    writer.str(intent.canonicalPayloadSchemaId);
    writer.uint(intent.schemaVersion);
    writer.bytes(Buffer.from(intent.machineIdentityId, "hex"));
    writer.str(intent.collaborationServerId);
    writer.str(intent.bootstrapSigningLeaseId);
    writer.str(intent.purpose);
    writer.optionalStr(intent.expectedPriorScopeCertificateId);
    writer.str(intent.proposedIdentityKeyId);
    writer.uint(intent.proposedKeyGeneration);
    writer.str(intent.proposedKeyAlgorithm);
    writer.bytes(publicKey);
    writer.str(intent.proposedScopeCertificateId);
    writer.str(intent.signingKeyRef);
    writer.uint(intent.preparedAtMs);
    return writer.finish();
  } finally {
    publicKey.fill(0);
  }
}

export function serverSignerBootstrapIntentDigest(value: unknown): A1Digest {
  const encoded = encodeServerSignerBootstrapIntentV1(value);
  const digest = createHash("sha256").update(encoded).digest();
  try {
    return parseA1Digest(base64urlEncode(digest));
  } finally {
    encoded.fill(0);
    digest.fill(0);
  }
}

export function parseServerIdentityKeyRecord(value: unknown): ServerIdentityKeyRecord {
  const row = parseExactRecord(
    value,
    [
      "collaborationServerId",
      "identityKeyId",
      "keyGeneration",
      "algorithm",
      "publicKey",
      "signingKeyRef",
      "introducedByScopeCertificateId",
      "trustEvidenceRef",
      "trustEvidenceDigest",
      "validFromMs",
      "state",
    ] as const,
    "serverIdentityKey",
  );
  const introduced = parseNullable(
    row.introducedByScopeCertificateId,
    parseA1SafeId,
    "serverIdentityKey.introducedByScopeCertificateId",
  );
  const state = parseEnum(
    row.state,
    ["proposed", "current", "retired", "revoked"] as const,
    "serverIdentityKey.state",
  );
  if ((state === "proposed") !== (introduced === null))
    reject(
      "serverIdentityKey.state",
      "proposed key introduction must be null and installed key introduction must be present",
    );
  return frozen({
    collaborationServerId: serverId(
      row.collaborationServerId,
      "serverIdentityKey.collaborationServerId",
    ),
    identityKeyId: parseA1SafeId(row.identityKeyId, "serverIdentityKey.identityKeyId"),
    keyGeneration: parsePositiveSafeInteger(row.keyGeneration, "serverIdentityKey.keyGeneration"),
    algorithm: parseLiteral(row.algorithm, "Ed25519", "serverIdentityKey.algorithm"),
    publicKey: parseEd25519PublicKey(row.publicKey, "serverIdentityKey.publicKey"),
    signingKeyRef: protectedHandleId(row.signingKeyRef, "serverIdentityKey.signingKeyRef"),
    introducedByScopeCertificateId: introduced,
    trustEvidenceRef: protectedHandleId(row.trustEvidenceRef, "serverIdentityKey.trustEvidenceRef"),
    trustEvidenceDigest: parseA1Digest(
      row.trustEvidenceDigest,
      "serverIdentityKey.trustEvidenceDigest",
    ),
    validFromMs: parseNonNegativeSafeInteger(row.validFromMs, "serverIdentityKey.validFromMs"),
    state,
  });
}

export function parseServerIdentityPrivateKeyEnvelopeRecord(
  value: unknown,
): ServerIdentityPrivateKeyEnvelopeRecord {
  const row = parseExactRecord(
    value,
    [
      "signingKeyRef",
      "collaborationServerId",
      "identityKeyId",
      "keyGeneration",
      "custodyBackend",
      "wrappingSchemaId",
      "wrapNonce",
      "wrappedPkcs8",
      "authTag",
      "pkcs8Digest",
      "createdAtMs",
      "destroyedAtMs",
      "state",
    ] as const,
    "serverIdentityPrivateKeyEnvelope",
  );
  const state = parseEnum(
    row.state,
    ["current", "destroyed"] as const,
    "serverIdentityPrivateKeyEnvelope.state",
  );
  const destroyedAtMs = parseNullable(
    row.destroyedAtMs,
    parseNonNegativeSafeInteger,
    "serverIdentityPrivateKeyEnvelope.destroyedAtMs",
  );
  if ((state === "destroyed") !== (destroyedAtMs !== null))
    reject("serverIdentityPrivateKeyEnvelope.state", "destroyed state and timestamp must agree");
  return frozen({
    signingKeyRef: protectedHandleId(
      row.signingKeyRef,
      "serverIdentityPrivateKeyEnvelope.signingKeyRef",
    ),
    collaborationServerId: serverId(
      row.collaborationServerId,
      "serverIdentityPrivateKeyEnvelope.collaborationServerId",
    ),
    identityKeyId: parseA1SafeId(
      row.identityKeyId,
      "serverIdentityPrivateKeyEnvelope.identityKeyId",
    ),
    keyGeneration: parsePositiveSafeInteger(
      row.keyGeneration,
      "serverIdentityPrivateKeyEnvelope.keyGeneration",
    ),
    custodyBackend: parseLiteral(
      row.custodyBackend,
      "owned-file",
      "serverIdentityPrivateKeyEnvelope.custodyBackend",
    ),
    wrappingSchemaId: parseLiteral(
      row.wrappingSchemaId,
      SERVER_KEY_WRAP_SCHEMA_ID,
      "serverIdentityPrivateKeyEnvelope.wrappingSchemaId",
    ),
    wrapNonce: snapshot(row.wrapNonce, 12, "serverIdentityPrivateKeyEnvelope.wrapNonce"),
    wrappedPkcs8: snapshot(row.wrappedPkcs8, null, "serverIdentityPrivateKeyEnvelope.wrappedPkcs8"),
    authTag: snapshot(row.authTag, 16, "serverIdentityPrivateKeyEnvelope.authTag"),
    pkcs8Digest: parseA1Digest(row.pkcs8Digest, "serverIdentityPrivateKeyEnvelope.pkcs8Digest"),
    createdAtMs: parseNonNegativeSafeInteger(
      row.createdAtMs,
      "serverIdentityPrivateKeyEnvelope.createdAtMs",
    ),
    destroyedAtMs,
    state,
  });
}

export function parseServerScopeCertificateStatusRecord(
  value: unknown,
): ServerScopeCertificateStatusRecord {
  const row = parseExactRecord(
    value,
    [
      "collaborationServerId",
      "scopeCertificateId",
      "state",
      "acceptSignaturesThroughSequence",
      "changedAtMs",
      "changeEvidenceRef",
      "changeEvidenceDigest",
    ] as const,
    "serverScopeCertificateStatus",
  );
  const state = parseEnum(
    row.state,
    ["current", "retired", "revoked"] as const,
    "serverScopeCertificateStatus.state",
  );
  const cutoff = parseNullable(
    row.acceptSignaturesThroughSequence,
    parseNonNegativeSafeInteger,
    "serverScopeCertificateStatus.acceptSignaturesThroughSequence",
  );
  if ((state === "retired") !== (cutoff !== null))
    reject(
      "serverScopeCertificateStatus.state",
      "only a retired certificate carries a signer cutoff",
    );
  return frozen({
    collaborationServerId: serverId(
      row.collaborationServerId,
      "serverScopeCertificateStatus.collaborationServerId",
    ),
    scopeCertificateId: parseA1SafeId(
      row.scopeCertificateId,
      "serverScopeCertificateStatus.scopeCertificateId",
    ),
    state,
    acceptSignaturesThroughSequence: cutoff,
    changedAtMs: parseNonNegativeSafeInteger(
      row.changedAtMs,
      "serverScopeCertificateStatus.changedAtMs",
    ),
    changeEvidenceRef: parseA1SafeId(
      row.changeEvidenceRef,
      "serverScopeCertificateStatus.changeEvidenceRef",
    ),
    changeEvidenceDigest: parseA1Digest(
      row.changeEvidenceDigest,
      "serverScopeCertificateStatus.changeEvidenceDigest",
    ),
  });
}

export function parseServerBootstrapSigningLeaseRecord(
  value: unknown,
): ServerBootstrapSigningLeaseRecord {
  const row = parseExactRecord(
    value,
    [
      "bootstrapSigningLeaseId",
      "collaborationServerId",
      "purpose",
      "operatorIntentEvidenceRef",
      "operatorIntentEvidenceDigest",
      "expectedPriorScopeCertificateId",
      "proposedIdentityKeyId",
      "proposedKeyGeneration",
      "proposedScopeCertificateId",
      "signingKeyRef",
      "coordinatorLeaseId",
      "coordinatorEpoch",
      "fencingToken",
      "preparedAtMs",
      "signedAtMs",
      "installedAtMs",
      "closedAtMs",
      "state",
    ] as const,
    "serverBootstrapSigningLease",
  );
  const purpose = parseEnum(
    row.purpose,
    ["initial_pair", "explicit_repair"] as const,
    "serverBootstrapSigningLease.purpose",
  );
  const expected = parseNullable(
    row.expectedPriorScopeCertificateId,
    parseA1SafeId,
    "serverBootstrapSigningLease.expectedPriorScopeCertificateId",
  );
  if ((purpose === "initial_pair") !== (expected === null))
    reject(
      "serverBootstrapSigningLease.purpose",
      "initial pair must have no predecessor and repair must name one",
    );
  return frozen({
    bootstrapSigningLeaseId: parseA1SafeId(
      row.bootstrapSigningLeaseId,
      "serverBootstrapSigningLease.bootstrapSigningLeaseId",
    ),
    collaborationServerId: serverId(
      row.collaborationServerId,
      "serverBootstrapSigningLease.collaborationServerId",
    ),
    purpose,
    operatorIntentEvidenceRef: protectedHandleId(
      row.operatorIntentEvidenceRef,
      "serverBootstrapSigningLease.operatorIntentEvidenceRef",
    ),
    operatorIntentEvidenceDigest: parseA1Digest(
      row.operatorIntentEvidenceDigest,
      "serverBootstrapSigningLease.operatorIntentEvidenceDigest",
    ),
    expectedPriorScopeCertificateId: expected,
    proposedIdentityKeyId: parseA1SafeId(
      row.proposedIdentityKeyId,
      "serverBootstrapSigningLease.proposedIdentityKeyId",
    ),
    proposedKeyGeneration: parsePositiveSafeInteger(
      row.proposedKeyGeneration,
      "serverBootstrapSigningLease.proposedKeyGeneration",
    ),
    proposedScopeCertificateId: parseA1SafeId(
      row.proposedScopeCertificateId,
      "serverBootstrapSigningLease.proposedScopeCertificateId",
    ),
    signingKeyRef: protectedHandleId(
      row.signingKeyRef,
      "serverBootstrapSigningLease.signingKeyRef",
    ),
    coordinatorLeaseId: coordinatorLeaseId(
      row.coordinatorLeaseId,
      "serverBootstrapSigningLease.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "serverBootstrapSigningLease.coordinatorEpoch",
    ),
    fencingToken: parsePositiveSafeInteger(
      row.fencingToken,
      "serverBootstrapSigningLease.fencingToken",
    ),
    preparedAtMs: parseNonNegativeSafeInteger(
      row.preparedAtMs,
      "serverBootstrapSigningLease.preparedAtMs",
    ),
    signedAtMs: parseNullable(
      row.signedAtMs,
      parseNonNegativeSafeInteger,
      "serverBootstrapSigningLease.signedAtMs",
    ),
    installedAtMs: parseNullable(
      row.installedAtMs,
      parseNonNegativeSafeInteger,
      "serverBootstrapSigningLease.installedAtMs",
    ),
    closedAtMs: parseNullable(
      row.closedAtMs,
      parseNonNegativeSafeInteger,
      "serverBootstrapSigningLease.closedAtMs",
    ),
    state: parseEnum(
      row.state,
      ["prepared", "signed", "installed", "closed"] as const,
      "serverBootstrapSigningLease.state",
    ),
  });
}

export function parseServerSigningLeaseRecord(value: unknown): ServerSigningLeaseRecord {
  const row = parseExactRecord(
    value,
    [
      "signingLeaseId",
      "collaborationServerId",
      "identityKeyId",
      "keyGeneration",
      "scopeCertificateId",
      "coordinatorLeaseId",
      "coordinatorEpoch",
      "fencingToken",
      "acquiredAtMs",
      "drainingAtMs",
      "supersededAtMs",
      "closedAtMs",
      "state",
    ] as const,
    "serverSigningLease",
  );
  return frozen({
    signingLeaseId: parseA1SafeId(row.signingLeaseId, "serverSigningLease.signingLeaseId"),
    collaborationServerId: serverId(
      row.collaborationServerId,
      "serverSigningLease.collaborationServerId",
    ),
    identityKeyId: parseA1SafeId(row.identityKeyId, "serverSigningLease.identityKeyId"),
    keyGeneration: parsePositiveSafeInteger(row.keyGeneration, "serverSigningLease.keyGeneration"),
    scopeCertificateId: parseA1SafeId(
      row.scopeCertificateId,
      "serverSigningLease.scopeCertificateId",
    ),
    coordinatorLeaseId: coordinatorLeaseId(
      row.coordinatorLeaseId,
      "serverSigningLease.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "serverSigningLease.coordinatorEpoch",
    ),
    fencingToken: parsePositiveSafeInteger(row.fencingToken, "serverSigningLease.fencingToken"),
    acquiredAtMs: parseNonNegativeSafeInteger(row.acquiredAtMs, "serverSigningLease.acquiredAtMs"),
    drainingAtMs: parseNullable(
      row.drainingAtMs,
      parseNonNegativeSafeInteger,
      "serverSigningLease.drainingAtMs",
    ),
    supersededAtMs: parseNullable(
      row.supersededAtMs,
      parseNonNegativeSafeInteger,
      "serverSigningLease.supersededAtMs",
    ),
    closedAtMs: parseNullable(
      row.closedAtMs,
      parseNonNegativeSafeInteger,
      "serverSigningLease.closedAtMs",
    ),
    state: parseEnum(
      row.state,
      ["current", "draining", "superseded", "closed"] as const,
      "serverSigningLease.state",
    ),
  });
}

export function parseServerSignatureReservationRecord(
  value: unknown,
): ServerSignatureReservationRecord {
  const row = parseExactRecord(
    value,
    [
      "collaborationServerId",
      "signerSequence",
      "signingLeaseId",
      "signingLeaseKind",
      "purpose",
      "canonicalPayloadSchemaId",
      "canonicalPayloadRef",
      "canonicalPayloadDigest",
      "signedRecordDigest",
      "signature",
      "signedArtifactType",
      "signedArtifactId",
      "reservedAtMs",
      "boundAtMs",
      "signedAtMs",
      "abortedAtMs",
      "state",
    ] as const,
    "serverSignatureReservation",
  );
  const purpose = parseEnum(
    row.purpose,
    SERVER_SIGNATURE_PURPOSES,
    "serverSignatureReservation.purpose",
  );
  const schema = parseNullable(
    row.canonicalPayloadSchemaId,
    (v, f) => parseLiteral(v, SERVER_SIGNATURE_SCHEMAS[purpose], f),
    "serverSignatureReservation.canonicalPayloadSchemaId",
  ) as ServerSignatureSchemaId | null;
  return frozen({
    collaborationServerId: serverId(
      row.collaborationServerId,
      "serverSignatureReservation.collaborationServerId",
    ),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "serverSignatureReservation.signerSequence",
    ),
    signingLeaseId: parseA1SafeId(row.signingLeaseId, "serverSignatureReservation.signingLeaseId"),
    signingLeaseKind: parseEnum(
      row.signingLeaseKind,
      ["current", "bootstrap"] as const,
      "serverSignatureReservation.signingLeaseKind",
    ),
    purpose,
    canonicalPayloadSchemaId: schema,
    canonicalPayloadRef: parseNullable(
      row.canonicalPayloadRef,
      protectedHandleId,
      "serverSignatureReservation.canonicalPayloadRef",
    ),
    canonicalPayloadDigest: parseNullable(
      row.canonicalPayloadDigest,
      parseA1Digest,
      "serverSignatureReservation.canonicalPayloadDigest",
    ),
    signedRecordDigest: parseNullable(
      row.signedRecordDigest,
      parseA1Digest,
      "serverSignatureReservation.signedRecordDigest",
    ),
    signature: parseNullable(
      row.signature,
      parseEd25519Signature,
      "serverSignatureReservation.signature",
    ),
    signedArtifactType: parseNullable(
      row.signedArtifactType,
      parseA1SafeId,
      "serverSignatureReservation.signedArtifactType",
    ),
    signedArtifactId: parseNullable(
      row.signedArtifactId,
      parseA1SafeId,
      "serverSignatureReservation.signedArtifactId",
    ),
    reservedAtMs: parseNonNegativeSafeInteger(
      row.reservedAtMs,
      "serverSignatureReservation.reservedAtMs",
    ),
    boundAtMs: parseNullable(
      row.boundAtMs,
      parseNonNegativeSafeInteger,
      "serverSignatureReservation.boundAtMs",
    ),
    signedAtMs: parseNullable(
      row.signedAtMs,
      parseNonNegativeSafeInteger,
      "serverSignatureReservation.signedAtMs",
    ),
    abortedAtMs: parseNullable(
      row.abortedAtMs,
      parseNonNegativeSafeInteger,
      "serverSignatureReservation.abortedAtMs",
    ),
    state: parseEnum(
      row.state,
      ["reserved", "bound", "signed", "aborted"] as const,
      "serverSignatureReservation.state",
    ),
  });
}

export function parseServerSignedRecordAcceptanceRecord(
  value: unknown,
): ServerSignedRecordAcceptanceRecord {
  const row = parseExactRecord(
    value,
    [
      "collaborationServerId",
      "acceptedAtJournalSeq",
      "signedRecordDigest",
      "signerIdentityKeyId",
      "signerKeyGeneration",
      "signerScopeCertificateId",
      "signerSequence",
      "acceptedAtMs",
      "historicalReattestationId",
    ] as const,
    "serverSignedRecordAcceptance",
  );
  return frozen({
    collaborationServerId: serverId(
      row.collaborationServerId,
      "serverSignedRecordAcceptance.collaborationServerId",
    ),
    acceptedAtJournalSeq: parseNonNegativeSafeInteger(
      row.acceptedAtJournalSeq,
      "serverSignedRecordAcceptance.acceptedAtJournalSeq",
    ),
    signedRecordDigest: parseA1Digest(
      row.signedRecordDigest,
      "serverSignedRecordAcceptance.signedRecordDigest",
    ),
    signerIdentityKeyId: parseA1SafeId(
      row.signerIdentityKeyId,
      "serverSignedRecordAcceptance.signerIdentityKeyId",
    ),
    signerKeyGeneration: parsePositiveSafeInteger(
      row.signerKeyGeneration,
      "serverSignedRecordAcceptance.signerKeyGeneration",
    ),
    signerScopeCertificateId: parseA1SafeId(
      row.signerScopeCertificateId,
      "serverSignedRecordAcceptance.signerScopeCertificateId",
    ),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "serverSignedRecordAcceptance.signerSequence",
    ),
    acceptedAtMs: parseNonNegativeSafeInteger(
      row.acceptedAtMs,
      "serverSignedRecordAcceptance.acceptedAtMs",
    ),
    historicalReattestationId: parseNullable(
      row.historicalReattestationId,
      parseA1SafeId,
      "serverSignedRecordAcceptance.historicalReattestationId",
    ),
  });
}
