// Pure A1 certificate and onboarding-attestation codecs. This module deliberately uses only
// Web Platform primitives: callers own key custody, sequence allocation, persistence, and trust
// policy; clawsec owns byte-exact canonicalization, digest construction, and Ed25519 verification.

import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { fromHex, sha256, timingSafeEqual } from "./bytes.js";
import { CanonicalWriter, canonicalByteLength, canonicalByteSnapshot } from "./canonical.js";

export const NATIVE_ROOT_CERTIFICATE_SCHEMA_ID = "remote-claw/native-root-certificate/v1" as const;
export const SERVER_SCOPE_CERTIFICATE_SCHEMA_ID =
  "remote-claw/server-scope-certificate/v1" as const;
export const VIEWER_ONBOARDING_KEYS_SCHEMA_ID = "remote-claw/viewer-onboarding-keys/v1" as const;

export const NATIVE_ROOT_CERTIFICATE_SIGNED_DOMAIN =
  "remote-claw/native-root-certificate-signed/v1" as const;
export const SERVER_SCOPE_CERTIFICATE_SIGNED_DOMAIN =
  "remote-claw/server-scope-certificate-signed/v1" as const;
export const VIEWER_ONBOARDING_KEYS_SIGNED_DOMAIN =
  "remote-claw/viewer-onboarding-keys-signed/v1" as const;
export const VIEWER_ONBOARDING_KEY_COMMITMENT_DOMAIN =
  "remote-claw/viewer-onboarding-key-commitment/v1" as const;

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const MACHINE_IDENTITY = /^[0-9a-f]{32}$/;
const MAX_SAFE_ID_LENGTH = 128;
const CANONICAL_ID_BODY_LENGTH = 16;
export const NATIVE_ROOT_MAX_TTL_MS = 300_000;
const DIGEST_LENGTH = 32;
const ED25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;
const PLACEHOLDER_DIGEST = base64urlEncode(new Uint8Array(DIGEST_LENGTH));
const PLACEHOLDER_SIGNATURE = base64urlEncode(new Uint8Array(ED25519_SIGNATURE_LENGTH));

export type A1CertificateErrorReason =
  | "invalid-record"
  | "invalid-field"
  | "digest-mismatch"
  | "signer-mismatch"
  | "signature-invalid";

export class A1CertificateError extends Error {
  readonly reason: A1CertificateErrorReason;

  constructor(reason: A1CertificateErrorReason, message: string) {
    super(message);
    this.name = "A1CertificateError";
    this.reason = reason;
  }

  static is(error: unknown): error is A1CertificateError {
    return error instanceof A1CertificateError;
  }
}

export interface A1Ed25519PublicKeyBinding {
  readonly identityKeyId: string;
  readonly keyGeneration: number;
  readonly algorithm: "Ed25519";
  /** Canonical unpadded base64url of the 32 raw Ed25519 public-key bytes. */
  readonly publicKey: string;
}

export interface NativeRootCertificate {
  readonly schemaVersion: 1;
  readonly canonicalPayloadSchemaId: typeof NATIVE_ROOT_CERTIFICATE_SCHEMA_ID;
  readonly rootPathCertificateId: string;
  readonly kind: "native-root";
  readonly terminalNativeBindingId: string;
  readonly terminalServerId: string;
  readonly terminalLogicalChatId: string;
  readonly terminalTopologyGeneration: number;
  readonly nativeBindingEvidenceDigest: string;
  readonly runtimeOwnerIdentityKeyId: string;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly signatureAlgorithm: "Ed25519";
  readonly canonicalPayloadDigestAlgorithm: "SHA-256";
  readonly canonicalPayloadDigest: string;
  readonly signature: string;
}

export type NativeRootCanonicalPayloadInput = Omit<
  NativeRootCertificate,
  "canonicalPayloadDigest" | "signature"
>;

export interface ServerScopeCertificateRecord {
  readonly schemaVersion: 1;
  readonly canonicalPayloadSchemaId: typeof SERVER_SCOPE_CERTIFICATE_SCHEMA_ID;
  readonly scopeCertificateId: string;
  readonly collaborationServerId: string;
  readonly machineIdentityId: string;
  readonly subjectIdentityKeyId: string;
  readonly subjectKeyAlgorithm: "Ed25519";
  readonly subjectPublicKey: string;
  readonly keyGeneration: number;
  readonly issuedAtMs: number;
  readonly supersedesScopeCertificateId: string | null;
  readonly signerIdentityKeyId: string;
  readonly signerSequence: number;
  readonly supersededSignerMaxSequence: number | null;
  readonly signatureAlgorithm: "Ed25519";
  readonly canonicalPayloadDigestAlgorithm: "SHA-256";
  readonly canonicalPayloadDigest: string;
  readonly signature: string;
}

export type ServerScopeCertificateCanonicalPayloadInput = Omit<
  ServerScopeCertificateRecord,
  "canonicalPayloadDigest" | "signature"
>;

export interface ViewerOnboardingKeyAttestationV1 {
  readonly schemaVersion: 1;
  readonly canonicalPayloadSchemaId: typeof VIEWER_ONBOARDING_KEYS_SCHEMA_ID;
  readonly collaborationServerId: string;
  readonly machineIdentityId: string;
  readonly scopeCertificateId: string;
  readonly keyGeneration: number;
  readonly signerIdentityKeyId: string;
  readonly signerSequence: number;
  readonly authTokenCommitment: string;
  readonly contentRootCommitment: string;
  readonly controlKeyCommitment: string;
  readonly metaKeyCommitment: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly canonicalPayloadDigestAlgorithm: "SHA-256";
  readonly canonicalPayloadDigest: string;
  readonly signature: string;
}

export type ViewerOnboardingKeyAttestationCanonicalPayloadInput = Omit<
  ViewerOnboardingKeyAttestationV1,
  "canonicalPayloadDigest" | "signature"
>;

export type ViewerOnboardingKeyLabel = "auth_token" | "content_root" | "control_key" | "meta_key";

export interface ViewerOnboardingKeyCommitments {
  readonly authTokenCommitment: string;
  readonly contentRootCommitment: string;
  readonly controlKeyCommitment: string;
  readonly metaKeyCommitment: string;
}

export interface ViewerOnboardingOperationalKeys {
  readonly authToken: Uint8Array;
  readonly contentRoot: Uint8Array;
  readonly controlKey: Uint8Array;
  readonly metaKey: Uint8Array;
}

const NATIVE_ROOT_CANONICAL_PAYLOAD_KEYS = [
  "schemaVersion",
  "canonicalPayloadSchemaId",
  "rootPathCertificateId",
  "kind",
  "terminalNativeBindingId",
  "terminalServerId",
  "terminalLogicalChatId",
  "terminalTopologyGeneration",
  "nativeBindingEvidenceDigest",
  "runtimeOwnerIdentityKeyId",
  "runtimeOwnerKeyGeneration",
  "signerSequence",
  "issuedAtMs",
  "expiresAtMs",
  "signatureAlgorithm",
  "canonicalPayloadDigestAlgorithm",
] as const;

const NATIVE_ROOT_KEYS = [
  ...NATIVE_ROOT_CANONICAL_PAYLOAD_KEYS,
  "canonicalPayloadDigest",
  "signature",
] as const;

const SERVER_SCOPE_CANONICAL_PAYLOAD_KEYS = [
  "schemaVersion",
  "canonicalPayloadSchemaId",
  "scopeCertificateId",
  "collaborationServerId",
  "machineIdentityId",
  "subjectIdentityKeyId",
  "subjectKeyAlgorithm",
  "subjectPublicKey",
  "keyGeneration",
  "issuedAtMs",
  "supersedesScopeCertificateId",
  "signerIdentityKeyId",
  "signerSequence",
  "supersededSignerMaxSequence",
  "signatureAlgorithm",
  "canonicalPayloadDigestAlgorithm",
] as const;

const SERVER_SCOPE_KEYS = [
  ...SERVER_SCOPE_CANONICAL_PAYLOAD_KEYS,
  "canonicalPayloadDigest",
  "signature",
] as const;

const ONBOARDING_ATTESTATION_CANONICAL_PAYLOAD_KEYS = [
  "schemaVersion",
  "canonicalPayloadSchemaId",
  "collaborationServerId",
  "machineIdentityId",
  "scopeCertificateId",
  "keyGeneration",
  "signerIdentityKeyId",
  "signerSequence",
  "authTokenCommitment",
  "contentRootCommitment",
  "controlKeyCommitment",
  "metaKeyCommitment",
  "signatureAlgorithm",
  "canonicalPayloadDigestAlgorithm",
] as const;

const ONBOARDING_ATTESTATION_KEYS = [
  ...ONBOARDING_ATTESTATION_CANONICAL_PAYLOAD_KEYS,
  "canonicalPayloadDigest",
  "signature",
] as const;

function reject(reason: A1CertificateErrorReason, message: string): never {
  throw new A1CertificateError(reason, message);
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  field: string,
): { readonly [P in K[number]]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("invalid-record", `${field} must be an object`);
  }

  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    reject("invalid-record", `${field} could not be inspected safely`);
  }
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    reject("invalid-record", `${field} must contain exactly the canonical fields`);
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      reject("invalid-record", `${field}.${key} could not be inspected safely`);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      reject("invalid-record", `${field}.${key} must be an own data property`);
    }
    snapshot[key] = descriptor.value as unknown;
  }
  return snapshot as { readonly [P in K[number]]: unknown };
}

function fixedValue<const T extends string | number>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) reject("invalid-field", `${field} must be ${JSON.stringify(expected)}`);
  return expected;
}

function safeId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SAFE_ID_LENGTH ||
    !SAFE_ID.test(value)
  ) {
    reject("invalid-field", `${field} must be 1-128 ASCII characters matching [A-Za-z0-9._:-]+`);
  }
  return value;
}

function canonicalId(value: unknown, prefix: string, field: string): string {
  const parsed = safeId(value, field);
  if (!parsed.startsWith(prefix)) {
    reject("invalid-field", `${field} must use the ${prefix} namespace`);
  }
  const body = parsed.slice(prefix.length);
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(body);
  } catch {
    reject("invalid-field", `${field} must contain a canonical 16-byte identifier`);
  }
  if (decoded.byteLength !== CANONICAL_ID_BODY_LENGTH || base64urlEncode(decoded) !== body) {
    reject("invalid-field", `${field} must contain a canonical 16-byte identifier`);
  }
  return parsed;
}

function machineIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !MACHINE_IDENTITY.test(value)) {
    reject("invalid-field", `${field} must be exactly 32 lowercase hexadecimal characters`);
  }
  return value;
}

function uint(value: unknown, field: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    Object.is(value, -0)
  ) {
    const qualifier = minimum === 0 ? "non-negative" : `at least ${minimum}`;
    reject("invalid-field", `${field} must be a ${qualifier} safe integer`);
  }
  return value;
}

function nullableSafeId(value: unknown, field: string): string | null {
  return value === null ? null : safeId(value, field);
}

function nullableUint(value: unknown, field: string): number | null {
  return value === null ? null : uint(value, field);
}

function canonicalBytes(value: unknown, length: number, field: string): string {
  if (typeof value !== "string" || value.length !== Math.ceil((length * 4) / 3)) {
    reject(
      "invalid-field",
      `${field} must be canonical unpadded base64url of exactly ${length} bytes`,
    );
  }
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(value);
  } catch {
    reject("invalid-field", `${field} must be canonical unpadded base64url`);
  }
  if (decoded.length !== length || base64urlEncode(decoded) !== value) {
    reject(
      "invalid-field",
      `${field} must be canonical unpadded base64url of exactly ${length} bytes`,
    );
  }
  return value;
}

function digest(value: unknown, field: string): string {
  return canonicalBytes(value, DIGEST_LENGTH, field);
}

function publicKey(value: unknown, field: string): string {
  return canonicalBytes(value, ED25519_PUBLIC_KEY_LENGTH, field);
}

function signature(value: unknown, field: string): string {
  return canonicalBytes(value, ED25519_SIGNATURE_LENGTH, field);
}

function decodeCanonicalBytes(value: string): Uint8Array {
  // Every caller first passes through canonicalBytes(), so this cannot admit an alias.
  return base64urlDecode(value);
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function parseA1Ed25519PublicKeyBinding(value: unknown): A1Ed25519PublicKeyBinding {
  const row = exactRecord(
    value,
    ["identityKeyId", "keyGeneration", "algorithm", "publicKey"] as const,
    "signer",
  );
  return freeze({
    identityKeyId: safeId(row.identityKeyId, "signer.identityKeyId"),
    keyGeneration: uint(row.keyGeneration, "signer.keyGeneration", 1),
    algorithm: fixedValue(row.algorithm, "Ed25519", "signer.algorithm"),
    publicKey: publicKey(row.publicKey, "signer.publicKey"),
  });
}

export function parseNativeRootCertificate(value: unknown): NativeRootCertificate {
  const row = exactRecord(value, NATIVE_ROOT_KEYS, "nativeRootCertificate");
  const issuedAtMs = uint(row.issuedAtMs, "nativeRootCertificate.issuedAtMs");
  const expiresAtMs = uint(row.expiresAtMs, "nativeRootCertificate.expiresAtMs");
  if (expiresAtMs <= issuedAtMs) {
    reject("invalid-field", "nativeRootCertificate.expiresAtMs must be greater than issuedAtMs");
  }
  if (expiresAtMs - issuedAtMs > NATIVE_ROOT_MAX_TTL_MS) {
    reject(
      "invalid-field",
      `nativeRootCertificate lifetime must not exceed ${NATIVE_ROOT_MAX_TTL_MS}ms`,
    );
  }
  return freeze({
    schemaVersion: fixedValue(row.schemaVersion, 1, "nativeRootCertificate.schemaVersion"),
    canonicalPayloadSchemaId: fixedValue(
      row.canonicalPayloadSchemaId,
      NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
      "nativeRootCertificate.canonicalPayloadSchemaId",
    ),
    rootPathCertificateId: safeId(
      row.rootPathCertificateId,
      "nativeRootCertificate.rootPathCertificateId",
    ),
    kind: fixedValue(row.kind, "native-root", "nativeRootCertificate.kind"),
    terminalNativeBindingId: canonicalId(
      row.terminalNativeBindingId,
      "rcnb_",
      "nativeRootCertificate.terminalNativeBindingId",
    ),
    terminalServerId: canonicalId(
      row.terminalServerId,
      "rcs_",
      "nativeRootCertificate.terminalServerId",
    ),
    terminalLogicalChatId: canonicalId(
      row.terminalLogicalChatId,
      "rcl_",
      "nativeRootCertificate.terminalLogicalChatId",
    ),
    terminalTopologyGeneration: uint(
      row.terminalTopologyGeneration,
      "nativeRootCertificate.terminalTopologyGeneration",
      1,
    ),
    nativeBindingEvidenceDigest: digest(
      row.nativeBindingEvidenceDigest,
      "nativeRootCertificate.nativeBindingEvidenceDigest",
    ),
    runtimeOwnerIdentityKeyId: safeId(
      row.runtimeOwnerIdentityKeyId,
      "nativeRootCertificate.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: uint(
      row.runtimeOwnerKeyGeneration,
      "nativeRootCertificate.runtimeOwnerKeyGeneration",
      1,
    ),
    signerSequence: uint(row.signerSequence, "nativeRootCertificate.signerSequence"),
    issuedAtMs,
    expiresAtMs,
    signatureAlgorithm: fixedValue(
      row.signatureAlgorithm,
      "Ed25519",
      "nativeRootCertificate.signatureAlgorithm",
    ),
    canonicalPayloadDigestAlgorithm: fixedValue(
      row.canonicalPayloadDigestAlgorithm,
      "SHA-256",
      "nativeRootCertificate.canonicalPayloadDigestAlgorithm",
    ),
    canonicalPayloadDigest: digest(
      row.canonicalPayloadDigest,
      "nativeRootCertificate.canonicalPayloadDigest",
    ),
    signature: signature(row.signature, "nativeRootCertificate.signature"),
  });
}

export function parseServerScopeCertificateRecord(value: unknown): ServerScopeCertificateRecord {
  const row = exactRecord(value, SERVER_SCOPE_KEYS, "serverScopeCertificate");
  const parsed = {
    schemaVersion: fixedValue(row.schemaVersion, 1, "serverScopeCertificate.schemaVersion"),
    canonicalPayloadSchemaId: fixedValue(
      row.canonicalPayloadSchemaId,
      SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
      "serverScopeCertificate.canonicalPayloadSchemaId",
    ),
    scopeCertificateId: safeId(row.scopeCertificateId, "serverScopeCertificate.scopeCertificateId"),
    collaborationServerId: canonicalId(
      row.collaborationServerId,
      "rcs_",
      "serverScopeCertificate.collaborationServerId",
    ),
    machineIdentityId: machineIdentity(
      row.machineIdentityId,
      "serverScopeCertificate.machineIdentityId",
    ),
    subjectIdentityKeyId: safeId(
      row.subjectIdentityKeyId,
      "serverScopeCertificate.subjectIdentityKeyId",
    ),
    subjectKeyAlgorithm: fixedValue(
      row.subjectKeyAlgorithm,
      "Ed25519",
      "serverScopeCertificate.subjectKeyAlgorithm",
    ),
    subjectPublicKey: publicKey(row.subjectPublicKey, "serverScopeCertificate.subjectPublicKey"),
    keyGeneration: uint(row.keyGeneration, "serverScopeCertificate.keyGeneration", 1),
    issuedAtMs: uint(row.issuedAtMs, "serverScopeCertificate.issuedAtMs"),
    supersedesScopeCertificateId: nullableSafeId(
      row.supersedesScopeCertificateId,
      "serverScopeCertificate.supersedesScopeCertificateId",
    ),
    signerIdentityKeyId: safeId(
      row.signerIdentityKeyId,
      "serverScopeCertificate.signerIdentityKeyId",
    ),
    signerSequence: uint(row.signerSequence, "serverScopeCertificate.signerSequence"),
    supersededSignerMaxSequence: nullableUint(
      row.supersededSignerMaxSequence,
      "serverScopeCertificate.supersededSignerMaxSequence",
    ),
    signatureAlgorithm: fixedValue(
      row.signatureAlgorithm,
      "Ed25519",
      "serverScopeCertificate.signatureAlgorithm",
    ),
    canonicalPayloadDigestAlgorithm: fixedValue(
      row.canonicalPayloadDigestAlgorithm,
      "SHA-256",
      "serverScopeCertificate.canonicalPayloadDigestAlgorithm",
    ),
    canonicalPayloadDigest: digest(
      row.canonicalPayloadDigest,
      "serverScopeCertificate.canonicalPayloadDigest",
    ),
    signature: signature(row.signature, "serverScopeCertificate.signature"),
  } satisfies ServerScopeCertificateRecord;

  if (parsed.supersedesScopeCertificateId === null) {
    if (parsed.signerIdentityKeyId !== parsed.subjectIdentityKeyId) {
      reject("invalid-field", "an initial server scope certificate must be self-signed");
    }
    if (parsed.supersededSignerMaxSequence !== null) {
      reject(
        "invalid-field",
        "an initial server scope certificate cannot contain a predecessor sequence cutoff",
      );
    }
  } else {
    if (parsed.keyGeneration < 2) {
      reject("invalid-field", "a successor server scope certificate must advance generation");
    }
    if (parsed.supersedesScopeCertificateId === parsed.scopeCertificateId) {
      reject("invalid-field", "a server scope certificate cannot supersede itself");
    }
    if (parsed.signerIdentityKeyId === parsed.subjectIdentityKeyId) {
      reject("invalid-field", "a successor server scope certificate must rotate its subject key");
    }
    if (parsed.supersededSignerMaxSequence !== parsed.signerSequence) {
      reject("invalid-field", "a successor certificate cutoff must equal its signer sequence");
    }
  }
  return freeze(parsed);
}

export function parseViewerOnboardingKeyAttestationV1(
  value: unknown,
): ViewerOnboardingKeyAttestationV1 {
  const row = exactRecord(value, ONBOARDING_ATTESTATION_KEYS, "viewerOnboardingKeyAttestation");
  return freeze({
    schemaVersion: fixedValue(row.schemaVersion, 1, "keyAttestation.schemaVersion"),
    canonicalPayloadSchemaId: fixedValue(
      row.canonicalPayloadSchemaId,
      VIEWER_ONBOARDING_KEYS_SCHEMA_ID,
      "keyAttestation.canonicalPayloadSchemaId",
    ),
    collaborationServerId: canonicalId(
      row.collaborationServerId,
      "rcs_",
      "keyAttestation.collaborationServerId",
    ),
    machineIdentityId: machineIdentity(row.machineIdentityId, "keyAttestation.machineIdentityId"),
    scopeCertificateId: safeId(row.scopeCertificateId, "keyAttestation.scopeCertificateId"),
    keyGeneration: uint(row.keyGeneration, "keyAttestation.keyGeneration", 1),
    signerIdentityKeyId: safeId(row.signerIdentityKeyId, "keyAttestation.signerIdentityKeyId"),
    signerSequence: uint(row.signerSequence, "keyAttestation.signerSequence"),
    authTokenCommitment: digest(row.authTokenCommitment, "keyAttestation.authTokenCommitment"),
    contentRootCommitment: digest(
      row.contentRootCommitment,
      "keyAttestation.contentRootCommitment",
    ),
    controlKeyCommitment: digest(row.controlKeyCommitment, "keyAttestation.controlKeyCommitment"),
    metaKeyCommitment: digest(row.metaKeyCommitment, "keyAttestation.metaKeyCommitment"),
    signatureAlgorithm: fixedValue(
      row.signatureAlgorithm,
      "Ed25519",
      "keyAttestation.signatureAlgorithm",
    ),
    canonicalPayloadDigestAlgorithm: fixedValue(
      row.canonicalPayloadDigestAlgorithm,
      "SHA-256",
      "keyAttestation.canonicalPayloadDigestAlgorithm",
    ),
    canonicalPayloadDigest: digest(
      row.canonicalPayloadDigest,
      "keyAttestation.canonicalPayloadDigest",
    ),
    signature: signature(row.signature, "keyAttestation.signature"),
  });
}

export function parseNativeRootCanonicalPayloadInput(
  value: unknown,
): NativeRootCanonicalPayloadInput {
  const row = exactRecord(value, NATIVE_ROOT_CANONICAL_PAYLOAD_KEYS, "nativeRootCanonicalPayload");
  const {
    canonicalPayloadDigest: _digest,
    signature: _signature,
    ...payload
  } = parseNativeRootCertificate({
    ...row,
    canonicalPayloadDigest: PLACEHOLDER_DIGEST,
    signature: PLACEHOLDER_SIGNATURE,
  });
  return freeze(payload);
}

export function parseServerScopeCertificateCanonicalPayloadInput(
  value: unknown,
): ServerScopeCertificateCanonicalPayloadInput {
  const row = exactRecord(
    value,
    SERVER_SCOPE_CANONICAL_PAYLOAD_KEYS,
    "serverScopeCertificateCanonicalPayload",
  );
  const {
    canonicalPayloadDigest: _digest,
    signature: _signature,
    ...payload
  } = parseServerScopeCertificateRecord({
    ...row,
    canonicalPayloadDigest: PLACEHOLDER_DIGEST,
    signature: PLACEHOLDER_SIGNATURE,
  });
  return freeze(payload);
}

export function parseViewerOnboardingKeyAttestationCanonicalPayloadInput(
  value: unknown,
): ViewerOnboardingKeyAttestationCanonicalPayloadInput {
  const row = exactRecord(
    value,
    ONBOARDING_ATTESTATION_CANONICAL_PAYLOAD_KEYS,
    "viewerOnboardingKeyAttestationCanonicalPayload",
  );
  const {
    canonicalPayloadDigest: _digest,
    signature: _signature,
    ...payload
  } = parseViewerOnboardingKeyAttestationV1({
    ...row,
    canonicalPayloadDigest: PLACEHOLDER_DIGEST,
    signature: PLACEHOLDER_SIGNATURE,
  });
  return freeze(payload);
}

function encodeNativeRootParsed(record: NativeRootCanonicalPayloadInput): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(record.canonicalPayloadSchemaId);
  writer.uint(record.schemaVersion);
  writer.str(record.rootPathCertificateId);
  writer.str(record.kind);
  writer.str(record.terminalNativeBindingId);
  writer.str(record.terminalServerId);
  writer.str(record.terminalLogicalChatId);
  writer.uint(record.terminalTopologyGeneration);
  writer.bytes(decodeCanonicalBytes(record.nativeBindingEvidenceDigest));
  writer.str(record.runtimeOwnerIdentityKeyId);
  writer.uint(record.runtimeOwnerKeyGeneration);
  writer.uint(record.signerSequence);
  writer.uint(record.issuedAtMs);
  writer.uint(record.expiresAtMs);
  writer.str(record.signatureAlgorithm);
  writer.str(record.canonicalPayloadDigestAlgorithm);
  return writer.finish();
}

export function encodeNativeRootCertificatePayload(value: unknown): Uint8Array {
  return encodeNativeRootParsed(parseNativeRootCertificate(value));
}

/** Canonicalize an unsigned native-root payload before its digest/signature fields exist. */
export function canonicalNativeRootPayload(value: unknown): Uint8Array {
  return encodeNativeRootParsed(parseNativeRootCanonicalPayloadInput(value));
}

function encodeServerScopeParsed(record: ServerScopeCertificateCanonicalPayloadInput): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(record.canonicalPayloadSchemaId);
  writer.uint(record.schemaVersion);
  writer.str(record.scopeCertificateId);
  writer.bytes(fromHex(record.machineIdentityId));
  writer.str(record.collaborationServerId);
  writer.str(record.subjectIdentityKeyId);
  writer.str(record.subjectKeyAlgorithm);
  writer.bytes(decodeCanonicalBytes(record.subjectPublicKey));
  writer.uint(record.keyGeneration);
  writer.uint(record.issuedAtMs);
  writer.optionalStr(record.supersedesScopeCertificateId);
  writer.str(record.signerIdentityKeyId);
  writer.uint(record.signerSequence);
  writer.optionalUint(record.supersededSignerMaxSequence);
  writer.str(record.signatureAlgorithm);
  writer.str(record.canonicalPayloadDigestAlgorithm);
  return writer.finish();
}

export function encodeServerScopeCertificatePayload(value: unknown): Uint8Array {
  return encodeServerScopeParsed(parseServerScopeCertificateRecord(value));
}

/** Canonicalize an unsigned server-scope certificate payload. */
export function canonicalServerScopeCertificatePayload(value: unknown): Uint8Array {
  return encodeServerScopeParsed(parseServerScopeCertificateCanonicalPayloadInput(value));
}

function encodeOnboardingAttestationParsed(
  record: ViewerOnboardingKeyAttestationCanonicalPayloadInput,
): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(record.canonicalPayloadSchemaId);
  writer.uint(record.schemaVersion);
  writer.str(record.collaborationServerId);
  writer.bytes(fromHex(record.machineIdentityId));
  writer.str(record.scopeCertificateId);
  writer.uint(record.keyGeneration);
  writer.str(record.signerIdentityKeyId);
  writer.uint(record.signerSequence);
  writer.bytes(decodeCanonicalBytes(record.authTokenCommitment));
  writer.bytes(decodeCanonicalBytes(record.contentRootCommitment));
  writer.bytes(decodeCanonicalBytes(record.controlKeyCommitment));
  writer.bytes(decodeCanonicalBytes(record.metaKeyCommitment));
  writer.str(record.signatureAlgorithm);
  writer.str(record.canonicalPayloadDigestAlgorithm);
  return writer.finish();
}

export function encodeViewerOnboardingKeyAttestationPayload(value: unknown): Uint8Array {
  return encodeOnboardingAttestationParsed(parseViewerOnboardingKeyAttestationV1(value));
}

/** Canonicalize an unsigned onboarding-key attestation payload. */
export function canonicalViewerOnboardingKeyAttestationPayload(value: unknown): Uint8Array {
  return encodeOnboardingAttestationParsed(
    parseViewerOnboardingKeyAttestationCanonicalPayloadInput(value),
  );
}

async function encodedDigest(bytes: Uint8Array): Promise<string> {
  return base64urlEncode(await sha256(bytes));
}

export async function nativeRootCertificatePayloadDigest(value: unknown): Promise<string> {
  return encodedDigest(encodeNativeRootCertificatePayload(value));
}

export async function nativeRootCanonicalPayloadDigest(value: unknown): Promise<string> {
  return encodedDigest(canonicalNativeRootPayload(value));
}

export async function serverScopeCertificatePayloadDigest(value: unknown): Promise<string> {
  return encodedDigest(encodeServerScopeCertificatePayload(value));
}

export async function serverScopeCertificateCanonicalPayloadDigest(
  value: unknown,
): Promise<string> {
  return encodedDigest(canonicalServerScopeCertificatePayload(value));
}

export async function viewerOnboardingKeyAttestationPayloadDigest(value: unknown): Promise<string> {
  return encodedDigest(encodeViewerOnboardingKeyAttestationPayload(value));
}

export async function viewerOnboardingKeyAttestationCanonicalPayloadDigest(
  value: unknown,
): Promise<string> {
  return encodedDigest(canonicalViewerOnboardingKeyAttestationPayload(value));
}

async function requireMatchingPayloadDigest(
  actualDigest: string,
  canonicalPayload: Uint8Array,
  field: string,
): Promise<void> {
  const expected = await sha256(canonicalPayload);
  if (!timingSafeEqual(expected, decodeCanonicalBytes(actualDigest))) {
    reject("digest-mismatch", `${field} does not match the canonical payload`);
  }
}

async function signedRecordDigest(
  domain: string,
  canonicalPayloadDigest: string,
  signerIdentityKeyId: string,
  signerKeyGeneration: number | null,
  signerSequence: number,
  encodedSignature: string,
): Promise<string> {
  const writer = new CanonicalWriter();
  writer.str(domain);
  writer.bytes(decodeCanonicalBytes(canonicalPayloadDigest));
  writer.str(signerIdentityKeyId);
  if (signerKeyGeneration !== null) writer.uint(signerKeyGeneration);
  writer.uint(signerSequence);
  writer.bytes(decodeCanonicalBytes(encodedSignature));
  return encodedDigest(writer.finish());
}

export async function nativeRootCertificateSignedRecordDigest(value: unknown): Promise<string> {
  const record = parseNativeRootCertificate(value);
  await requireMatchingPayloadDigest(
    record.canonicalPayloadDigest,
    encodeNativeRootParsed(record),
    "nativeRootCertificate.canonicalPayloadDigest",
  );
  return signedRecordDigest(
    NATIVE_ROOT_CERTIFICATE_SIGNED_DOMAIN,
    record.canonicalPayloadDigest,
    record.runtimeOwnerIdentityKeyId,
    record.runtimeOwnerKeyGeneration,
    record.signerSequence,
    record.signature,
  );
}

/**
 * The server-scope DTO does not duplicate the trusted signer's generation: on a rotation that is the
 * predecessor certificate's generation, not the new subject generation. It is nevertheless unique:
 * self-signed anchors use their subject generation and successors use `keyGeneration - 1`, so the
 * signed-record digest still commits to the complete common signer tuple.
 */
export async function serverScopeCertificateSignedRecordDigest(value: unknown): Promise<string> {
  const record = parseServerScopeCertificateRecord(value);
  await requireMatchingPayloadDigest(
    record.canonicalPayloadDigest,
    encodeServerScopeParsed(record),
    "serverScopeCertificate.canonicalPayloadDigest",
  );
  return signedRecordDigest(
    SERVER_SCOPE_CERTIFICATE_SIGNED_DOMAIN,
    record.canonicalPayloadDigest,
    record.signerIdentityKeyId,
    serverScopeCertificateSignerKeyGeneration(record),
    record.signerSequence,
    record.signature,
  );
}

/** The signer is the subject itself for an anchor and the immediately preceding generation otherwise. */
export function serverScopeCertificateSignerKeyGeneration(value: unknown): number {
  const record = parseServerScopeCertificateRecord(value);
  return record.supersedesScopeCertificateId === null
    ? record.keyGeneration
    : record.keyGeneration - 1;
}

export async function viewerOnboardingKeyAttestationSignedRecordDigest(
  value: unknown,
): Promise<string> {
  const record = parseViewerOnboardingKeyAttestationV1(value);
  await requireMatchingPayloadDigest(
    record.canonicalPayloadDigest,
    encodeOnboardingAttestationParsed(record),
    "keyAttestation.canonicalPayloadDigest",
  );
  return signedRecordDigest(
    VIEWER_ONBOARDING_KEYS_SIGNED_DOMAIN,
    record.canonicalPayloadDigest,
    record.signerIdentityKeyId,
    record.keyGeneration,
    record.signerSequence,
    record.signature,
  );
}

async function verifyEd25519(
  canonicalPayload: Uint8Array,
  encodedSignature: string,
  encodedPublicKey: string,
): Promise<void> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decodeCanonicalBytes(encodedPublicKey) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    reject("invalid-field", "signer.publicKey is not an importable raw Ed25519 public key");
  }
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      decodeCanonicalBytes(encodedSignature) as BufferSource,
      canonicalPayload as BufferSource,
    );
  } catch {
    // WebCrypto implementations may reject malformed/non-canonical Ed25519 points rather than
    // returning false. Both outcomes are one fail-closed protocol result.
  }
  if (!verified) reject("signature-invalid", "Ed25519 signature verification failed");
}

export async function verifyNativeRootCertificate(
  value: unknown,
  signerValue: unknown,
): Promise<NativeRootCertificate> {
  const record = parseNativeRootCertificate(value);
  const signer = parseA1Ed25519PublicKeyBinding(signerValue);
  if (
    signer.identityKeyId !== record.runtimeOwnerIdentityKeyId ||
    signer.keyGeneration !== record.runtimeOwnerKeyGeneration
  ) {
    reject("signer-mismatch", "native root signer binding does not match the certificate");
  }
  const payload = encodeNativeRootParsed(record);
  await requireMatchingPayloadDigest(
    record.canonicalPayloadDigest,
    payload,
    "nativeRootCertificate.canonicalPayloadDigest",
  );
  await verifyEd25519(payload, record.signature, signer.publicKey);
  return record;
}

export async function verifyServerScopeCertificate(
  value: unknown,
  signerValue: unknown,
): Promise<ServerScopeCertificateRecord> {
  const record = parseServerScopeCertificateRecord(value);
  const signer = parseA1Ed25519PublicKeyBinding(signerValue);
  if (
    signer.identityKeyId !== record.signerIdentityKeyId ||
    signer.keyGeneration !== serverScopeCertificateSignerKeyGeneration(record) ||
    (record.supersedesScopeCertificateId === null &&
      signer.publicKey !== record.subjectPublicKey) ||
    (record.supersedesScopeCertificateId !== null && signer.publicKey === record.subjectPublicKey)
  ) {
    reject("signer-mismatch", "server scope signer binding does not match the certificate");
  }
  const payload = encodeServerScopeParsed(record);
  await requireMatchingPayloadDigest(
    record.canonicalPayloadDigest,
    payload,
    "serverScopeCertificate.canonicalPayloadDigest",
  );
  await verifyEd25519(payload, record.signature, signer.publicKey);
  return record;
}

export async function verifyViewerOnboardingKeyAttestation(
  value: unknown,
  signerValue: unknown,
): Promise<ViewerOnboardingKeyAttestationV1> {
  const record = parseViewerOnboardingKeyAttestationV1(value);
  const signer = parseA1Ed25519PublicKeyBinding(signerValue);
  if (
    signer.identityKeyId !== record.signerIdentityKeyId ||
    signer.keyGeneration !== record.keyGeneration
  ) {
    reject("signer-mismatch", "onboarding attestation signer binding does not match the record");
  }
  const payload = encodeOnboardingAttestationParsed(record);
  await requireMatchingPayloadDigest(
    record.canonicalPayloadDigest,
    payload,
    "keyAttestation.canonicalPayloadDigest",
  );
  await verifyEd25519(payload, record.signature, signer.publicKey);
  return record;
}

export async function viewerOnboardingKeyCommitment(
  label: ViewerOnboardingKeyLabel,
  keyBytes: Uint8Array,
): Promise<string> {
  if (
    label !== "auth_token" &&
    label !== "content_root" &&
    label !== "control_key" &&
    label !== "meta_key"
  ) {
    reject("invalid-field", "onboarding key commitment label is not recognized");
  }
  let snapshot: Uint8Array;
  try {
    snapshot = canonicalByteSnapshot(keyBytes);
  } catch {
    reject("invalid-field", "onboarding key commitment input must be exactly 32 bytes");
  }
  if (canonicalByteLength(snapshot) !== 32) {
    reject("invalid-field", "onboarding key commitment input must be exactly 32 bytes");
  }
  const writer = new CanonicalWriter();
  writer.str(VIEWER_ONBOARDING_KEY_COMMITMENT_DOMAIN);
  writer.str(label);
  writer.bytes(snapshot);
  return encodedDigest(writer.finish());
}

export async function viewerOnboardingKeyCommitments(
  keys: ViewerOnboardingOperationalKeys,
): Promise<ViewerOnboardingKeyCommitments> {
  const row = exactRecord(
    keys,
    ["authToken", "contentRoot", "controlKey", "metaKey"] as const,
    "onboardingKeys",
  );
  const [authTokenCommitment, contentRootCommitment, controlKeyCommitment, metaKeyCommitment] =
    await Promise.all([
      viewerOnboardingKeyCommitment("auth_token", row.authToken as Uint8Array),
      viewerOnboardingKeyCommitment("content_root", row.contentRoot as Uint8Array),
      viewerOnboardingKeyCommitment("control_key", row.controlKey as Uint8Array),
      viewerOnboardingKeyCommitment("meta_key", row.metaKey as Uint8Array),
    ]);
  return freeze({
    authTokenCommitment,
    contentRootCommitment,
    controlKeyCommitment,
    metaKeyCommitment,
  });
}
