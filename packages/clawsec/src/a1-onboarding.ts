// Canonical ViewerOnboardingBundleV2 DTO and `rcp2` transfer wire. This is a pure verifier: it
// retains no trust state or credentials and opens no broker route. Callers install the verified
// result atomically under their own trust-store policy.

import {
  type A1Ed25519PublicKeyBinding,
  encodeServerScopeCertificatePayload,
  encodeViewerOnboardingKeyAttestationPayload,
  parseServerScopeCertificateRecord,
  parseViewerOnboardingKeyAttestationV1,
  type ServerScopeCertificateRecord,
  type ViewerOnboardingKeyAttestationV1,
  verifyServerScopeCertificate,
  verifyViewerOnboardingKeyAttestation,
  viewerOnboardingKeyCommitments,
} from "./a1-certificates.js";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { sha256, timingSafeEqual, toHex } from "./bytes.js";
import { CanonicalWriter, canonicalByteSnapshot } from "./canonical.js";

export const VIEWER_ONBOARDING_BUNDLE_DOMAIN = "remote-claw/viewer-onboarding-bundle/v2" as const;
export const VIEWER_ONBOARDING_WIRE_CHECKSUM_DOMAIN =
  "remote-claw/viewer-onboarding-wire-checksum/v2" as const;

const WIRE_PREFIX = "rcp2.";
const MAX_SAFE_ID_LENGTH = 128;
const MAX_CERTIFICATE_CHAIN_LENGTH = 32;
const MAX_NESTED_PAYLOAD_BYTES = 4 * 1024;
const MAX_CANONICAL_BUNDLE_BYTES = 256 * 1024;
const MAX_WIRE_TEXT_LENGTH = Math.ceil((MAX_CANONICAL_BUNDLE_BYTES * 4) / 3) + 50;
const CANONICAL_ID_BODY_LENGTH = 16;
const KEY_LENGTH = 32;
const DIGEST_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const MACHINE_IDENTITY = /^[0-9a-f]{32}$/;

export type ViewerOnboardingErrorReason =
  | "invalid-record"
  | "invalid-field"
  | "bad-prefix"
  | "bad-length"
  | "bad-encoding"
  | "bad-checksum"
  | "noncanonical-wire"
  | "identity-mismatch"
  | "certificate-chain-invalid"
  | "key-mismatch"
  | "attestation-mismatch";

export class ViewerOnboardingError extends Error {
  readonly reason: ViewerOnboardingErrorReason;

  constructor(reason: ViewerOnboardingErrorReason, message: string) {
    super(message);
    this.name = "ViewerOnboardingError";
    this.reason = reason;
  }

  static is(error: unknown): error is ViewerOnboardingError {
    return error instanceof ViewerOnboardingError;
  }
}

export interface ViewerOnboardingServerIdentityKey {
  readonly identityKeyId: string;
  readonly algorithm: "Ed25519";
  readonly publicKey: string;
}

export interface ViewerOnboardingBundleV2 {
  readonly version: 2;
  readonly machineIdentityId: string;
  readonly collaborationServerId: string;
  readonly authToken: string;
  readonly contentRoot: string;
  readonly controlKey: string;
  readonly metaKey: string;
  readonly serverIdentityKey: ViewerOnboardingServerIdentityKey;
  readonly scopeCertificateChain: readonly ServerScopeCertificateRecord[];
  readonly keyAttestation: ViewerOnboardingKeyAttestationV1;
}

export interface VerifyViewerOnboardingBundleOptions {
  /**
   * Existing-pair suffix mode: the first supplied certificate must match this already-trusted
   * certificate byte-for-byte. The caller's trust store remains responsible for immutable key-ID
   * and public-key bindings in any older history omitted from the suffix. Without this option the
   * verifier requires a self-signed cold-pair anchor.
   */
  readonly trustedFirstCertificate?: ServerScopeCertificateRecord;
  /** Optional out-of-band pin for the bundle's current/tip server identity key. */
  readonly expectedServerIdentityKey?: ViewerOnboardingServerIdentityKey;
}

const BUNDLE_KEYS = [
  "version",
  "machineIdentityId",
  "collaborationServerId",
  "authToken",
  "contentRoot",
  "controlKey",
  "metaKey",
  "serverIdentityKey",
  "scopeCertificateChain",
  "keyAttestation",
] as const;

const SERVER_IDENTITY_KEY_KEYS = ["identityKeyId", "algorithm", "publicKey"] as const;

function reject(reason: ViewerOnboardingErrorReason, message: string): never {
  throw new ViewerOnboardingError(reason, message);
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

function collaborationServerId(value: unknown, field: string): string {
  const parsed = safeId(value, field);
  if (!parsed.startsWith("rcs_")) {
    reject("invalid-field", `${field} must use the rcs_ namespace`);
  }
  const body = parsed.slice(4);
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
  if (decoded.byteLength !== length || base64urlEncode(decoded) !== value) {
    reject(
      "invalid-field",
      `${field} must be canonical unpadded base64url of exactly ${length} bytes`,
    );
  }
  return value;
}

function parseServerIdentityKey(value: unknown): ViewerOnboardingServerIdentityKey {
  const row = exactRecord(value, SERVER_IDENTITY_KEY_KEYS, "bundle.serverIdentityKey");
  return Object.freeze({
    identityKeyId: safeId(row.identityKeyId, "bundle.serverIdentityKey.identityKeyId"),
    algorithm: fixedValue(row.algorithm, "Ed25519", "bundle.serverIdentityKey.algorithm"),
    publicKey: canonicalBytes(row.publicKey, KEY_LENGTH, "bundle.serverIdentityKey.publicKey"),
  });
}

function snapshotCertificateChain(value: unknown): readonly ServerScopeCertificateRecord[] {
  if (!Array.isArray(value)) {
    reject("invalid-record", "bundle.scopeCertificateChain must be an array");
  }
  if (value.length < 1 || value.length > MAX_CERTIFICATE_CHAIN_LENGTH) {
    reject(
      "bad-length",
      `bundle.scopeCertificateChain must contain 1-${MAX_CERTIFICATE_CHAIN_LENGTH} certificates`,
    );
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length),
    )
  ) {
    reject("invalid-record", "bundle.scopeCertificateChain must not contain extra properties");
  }
  const certificates: ServerScopeCertificateRecord[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      reject(
        "invalid-record",
        `bundle.scopeCertificateChain[${index}] must be an own data property`,
      );
    }
    certificates.push(parseServerScopeCertificateRecord(descriptor.value));
  }
  return Object.freeze(certificates);
}

export function parseViewerOnboardingBundleV2(value: unknown): ViewerOnboardingBundleV2 {
  const row = exactRecord(value, BUNDLE_KEYS, "viewerOnboardingBundle");
  if (typeof row.machineIdentityId !== "string" || !MACHINE_IDENTITY.test(row.machineIdentityId)) {
    reject(
      "invalid-field",
      "bundle.machineIdentityId must be exactly 32 lowercase hexadecimal characters",
    );
  }
  return Object.freeze({
    version: fixedValue(row.version, 2, "bundle.version"),
    machineIdentityId: row.machineIdentityId,
    collaborationServerId: collaborationServerId(
      row.collaborationServerId,
      "bundle.collaborationServerId",
    ),
    authToken: canonicalBytes(row.authToken, KEY_LENGTH, "bundle.authToken"),
    contentRoot: canonicalBytes(row.contentRoot, KEY_LENGTH, "bundle.contentRoot"),
    controlKey: canonicalBytes(row.controlKey, KEY_LENGTH, "bundle.controlKey"),
    metaKey: canonicalBytes(row.metaKey, KEY_LENGTH, "bundle.metaKey"),
    serverIdentityKey: parseServerIdentityKey(row.serverIdentityKey),
    scopeCertificateChain: snapshotCertificateChain(row.scopeCertificateChain),
    keyAttestation: parseViewerOnboardingKeyAttestationV1(row.keyAttestation),
  });
}

function encodeBundleParsed(bundle: ViewerOnboardingBundleV2): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(VIEWER_ONBOARDING_BUNDLE_DOMAIN);
  writer.uint(bundle.version);
  writer.bytes(hexIdentity(bundle.machineIdentityId));
  writer.str(bundle.collaborationServerId);
  writer.bytes(base64urlDecode(bundle.authToken));
  writer.bytes(base64urlDecode(bundle.contentRoot));
  writer.bytes(base64urlDecode(bundle.controlKey));
  writer.bytes(base64urlDecode(bundle.metaKey));
  writer.str(bundle.serverIdentityKey.identityKeyId);
  writer.str(bundle.serverIdentityKey.algorithm);
  writer.bytes(base64urlDecode(bundle.serverIdentityKey.publicKey));
  writer.uint(bundle.scopeCertificateChain.length);
  for (const certificate of bundle.scopeCertificateChain) {
    writer.bytes(encodeServerScopeCertificatePayload(certificate));
    writer.bytes(base64urlDecode(certificate.canonicalPayloadDigest));
    writer.bytes(base64urlDecode(certificate.signature));
  }
  writer.bytes(encodeViewerOnboardingKeyAttestationPayload(bundle.keyAttestation));
  writer.bytes(base64urlDecode(bundle.keyAttestation.canonicalPayloadDigest));
  writer.bytes(base64urlDecode(bundle.keyAttestation.signature));
  const bytes = writer.finish();
  if (bytes.byteLength > MAX_CANONICAL_BUNDLE_BYTES) {
    reject("bad-length", "canonical onboarding bundle exceeds the transfer size limit");
  }
  return bytes;
}

function hexIdentity(value: string): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function canonicalViewerOnboardingBundleBytes(value: unknown): Uint8Array {
  return encodeBundleParsed(parseViewerOnboardingBundleV2(value));
}

async function checksumBytes(canonicalBundleBytes: Uint8Array): Promise<Uint8Array> {
  const writer = new CanonicalWriter();
  writer.str(VIEWER_ONBOARDING_WIRE_CHECKSUM_DOMAIN);
  writer.bytes(canonicalBundleBytes);
  return sha256(writer.finish());
}

export async function viewerOnboardingBundleChecksum(value: unknown): Promise<string> {
  const bytes = canonicalViewerOnboardingBundleBytes(value);
  return base64urlEncode(await checksumBytes(bytes));
}

export async function formatViewerOnboardingBundle(value: unknown): Promise<string> {
  const bytes = canonicalViewerOnboardingBundleBytes(value);
  const checksum = await checksumBytes(bytes);
  return `${WIRE_PREFIX}${base64urlEncode(bytes)}.${base64urlEncode(checksum)}`;
}

class CanonicalReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = canonicalByteSnapshot(bytes);
  }

  #remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  #rawByte(field: string): number {
    if (this.#remaining() < 1) reject("bad-length", `${field} is truncated`);
    const value = this.#bytes[this.#offset];
    this.#offset++;
    if (value === undefined) reject("bad-length", `${field} is truncated`);
    return value;
  }

  bytes(field: string, maximum: number, exact?: number): Uint8Array {
    if (this.#remaining() < 4) reject("bad-length", `${field} length prefix is truncated`);
    const length = new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset + this.#offset,
      4,
    ).getUint32(0, false);
    this.#offset += 4;
    if (length > maximum) reject("bad-length", `${field} exceeds its ${maximum}-byte limit`);
    if (exact !== undefined && length !== exact) {
      reject("bad-length", `${field} must contain exactly ${exact} bytes`);
    }
    if (length > this.#remaining()) reject("bad-length", `${field} is truncated`);
    const value = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  str(field: string, maximum = MAX_SAFE_ID_LENGTH): string {
    const bytes = this.bytes(field, maximum);
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      reject("bad-encoding", `${field} is not valid UTF-8`);
    }
    return decoded;
  }

  uint(field: string): number {
    const bytes = this.bytes(field, 8, 8);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
      0,
      false,
    );
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      reject("invalid-field", `${field} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(value);
  }

  optionalStr(field: string): string | null {
    const present = this.#rawByte(`${field}.presence`);
    if (present === 0) return null;
    if (present !== 1) reject("noncanonical-wire", `${field} has a noncanonical presence byte`);
    return this.str(field);
  }

  optionalUint(field: string): number | null {
    const present = this.#rawByte(`${field}.presence`);
    if (present === 0) return null;
    if (present !== 1) reject("noncanonical-wire", `${field} has a noncanonical presence byte`);
    return this.uint(field);
  }

  finish(field: string): void {
    if (this.#remaining() !== 0) reject("noncanonical-wire", `${field} contains trailing bytes`);
  }
}

function decodeServerScopePayload(
  payload: Uint8Array,
  canonicalPayloadDigest: string,
  signature: string,
): ServerScopeCertificateRecord {
  const reader = new CanonicalReader(payload);
  const value = {
    canonicalPayloadSchemaId: reader.str("certificate.canonicalPayloadSchemaId"),
    schemaVersion: reader.uint("certificate.schemaVersion"),
    scopeCertificateId: reader.str("certificate.scopeCertificateId"),
    machineIdentityId: toHex(reader.bytes("certificate.machineIdentityId", 16, 16)),
    collaborationServerId: reader.str("certificate.collaborationServerId"),
    subjectIdentityKeyId: reader.str("certificate.subjectIdentityKeyId"),
    subjectKeyAlgorithm: reader.str("certificate.subjectKeyAlgorithm", 16),
    subjectPublicKey: base64urlEncode(reader.bytes("certificate.subjectPublicKey", 32, 32)),
    keyGeneration: reader.uint("certificate.keyGeneration"),
    issuedAtMs: reader.uint("certificate.issuedAtMs"),
    supersedesScopeCertificateId: reader.optionalStr("certificate.supersedesScopeCertificateId"),
    signerIdentityKeyId: reader.str("certificate.signerIdentityKeyId"),
    signerSequence: reader.uint("certificate.signerSequence"),
    supersededSignerMaxSequence: reader.optionalUint("certificate.supersededSignerMaxSequence"),
    signatureAlgorithm: reader.str("certificate.signatureAlgorithm", 16),
    canonicalPayloadDigestAlgorithm: reader.str("certificate.canonicalPayloadDigestAlgorithm", 16),
    canonicalPayloadDigest,
    signature,
  };
  reader.finish("certificate canonical payload");
  try {
    return parseServerScopeCertificateRecord(value);
  } catch (error) {
    reject(
      "noncanonical-wire",
      `invalid nested server scope certificate: ${error instanceof Error ? error.message : "error"}`,
    );
  }
}

function decodeAttestationPayload(
  payload: Uint8Array,
  canonicalPayloadDigest: string,
  signature: string,
): ViewerOnboardingKeyAttestationV1 {
  const reader = new CanonicalReader(payload);
  const value = {
    canonicalPayloadSchemaId: reader.str("keyAttestation.canonicalPayloadSchemaId"),
    schemaVersion: reader.uint("keyAttestation.schemaVersion"),
    collaborationServerId: reader.str("keyAttestation.collaborationServerId"),
    machineIdentityId: toHex(reader.bytes("keyAttestation.machineIdentityId", 16, 16)),
    scopeCertificateId: reader.str("keyAttestation.scopeCertificateId"),
    keyGeneration: reader.uint("keyAttestation.keyGeneration"),
    signerIdentityKeyId: reader.str("keyAttestation.signerIdentityKeyId"),
    signerSequence: reader.uint("keyAttestation.signerSequence"),
    authTokenCommitment: base64urlEncode(
      reader.bytes("keyAttestation.authTokenCommitment", 32, 32),
    ),
    contentRootCommitment: base64urlEncode(
      reader.bytes("keyAttestation.contentRootCommitment", 32, 32),
    ),
    controlKeyCommitment: base64urlEncode(
      reader.bytes("keyAttestation.controlKeyCommitment", 32, 32),
    ),
    metaKeyCommitment: base64urlEncode(reader.bytes("keyAttestation.metaKeyCommitment", 32, 32)),
    signatureAlgorithm: reader.str("keyAttestation.signatureAlgorithm", 16),
    canonicalPayloadDigestAlgorithm: reader.str(
      "keyAttestation.canonicalPayloadDigestAlgorithm",
      16,
    ),
    canonicalPayloadDigest,
    signature,
  };
  reader.finish("key attestation canonical payload");
  try {
    return parseViewerOnboardingKeyAttestationV1(value);
  } catch (error) {
    reject(
      "noncanonical-wire",
      `invalid nested key attestation: ${error instanceof Error ? error.message : "error"}`,
    );
  }
}

function decodeCanonicalBundle(bytes: Uint8Array): ViewerOnboardingBundleV2 {
  const reader = new CanonicalReader(bytes);
  const domain = reader.str("bundle.domain", VIEWER_ONBOARDING_BUNDLE_DOMAIN.length);
  if (domain !== VIEWER_ONBOARDING_BUNDLE_DOMAIN) {
    reject("noncanonical-wire", "onboarding bundle domain is not recognized");
  }
  const version = reader.uint("bundle.version");
  const machineIdentityId = toHex(reader.bytes("bundle.machineIdentityId", 16, 16));
  const collaborationServerId = reader.str("bundle.collaborationServerId");
  const authToken = base64urlEncode(reader.bytes("bundle.authToken", KEY_LENGTH, KEY_LENGTH));
  const contentRoot = base64urlEncode(reader.bytes("bundle.contentRoot", KEY_LENGTH, KEY_LENGTH));
  const controlKey = base64urlEncode(reader.bytes("bundle.controlKey", KEY_LENGTH, KEY_LENGTH));
  const metaKey = base64urlEncode(reader.bytes("bundle.metaKey", KEY_LENGTH, KEY_LENGTH));
  const serverIdentityKey = {
    identityKeyId: reader.str("bundle.serverIdentityKey.identityKeyId"),
    algorithm: reader.str("bundle.serverIdentityKey.algorithm", 16),
    publicKey: base64urlEncode(
      reader.bytes("bundle.serverIdentityKey.publicKey", KEY_LENGTH, KEY_LENGTH),
    ),
  };
  const certificateCount = reader.uint("bundle.scopeCertificateChain.length");
  if (certificateCount < 1 || certificateCount > MAX_CERTIFICATE_CHAIN_LENGTH) {
    reject(
      "bad-length",
      `bundle.scopeCertificateChain must contain 1-${MAX_CERTIFICATE_CHAIN_LENGTH} certificates`,
    );
  }
  const scopeCertificateChain: ServerScopeCertificateRecord[] = [];
  for (let index = 0; index < certificateCount; index++) {
    const payload = reader.bytes(
      `bundle.scopeCertificateChain[${index}].canonicalPayload`,
      MAX_NESTED_PAYLOAD_BYTES,
    );
    const payloadDigest = base64urlEncode(
      reader.bytes(
        `bundle.scopeCertificateChain[${index}].canonicalPayloadDigest`,
        DIGEST_LENGTH,
        DIGEST_LENGTH,
      ),
    );
    const certificateSignature = base64urlEncode(
      reader.bytes(
        `bundle.scopeCertificateChain[${index}].signature`,
        SIGNATURE_LENGTH,
        SIGNATURE_LENGTH,
      ),
    );
    scopeCertificateChain.push(
      decodeServerScopePayload(payload, payloadDigest, certificateSignature),
    );
  }
  const attestationPayload = reader.bytes(
    "bundle.keyAttestation.canonicalPayload",
    MAX_NESTED_PAYLOAD_BYTES,
  );
  const attestationDigest = base64urlEncode(
    reader.bytes("bundle.keyAttestation.canonicalPayloadDigest", DIGEST_LENGTH, DIGEST_LENGTH),
  );
  const attestationSignature = base64urlEncode(
    reader.bytes("bundle.keyAttestation.signature", SIGNATURE_LENGTH, SIGNATURE_LENGTH),
  );
  const keyAttestation = decodeAttestationPayload(
    attestationPayload,
    attestationDigest,
    attestationSignature,
  );
  reader.finish("canonical onboarding bundle");
  return parseViewerOnboardingBundleV2({
    version,
    machineIdentityId,
    collaborationServerId,
    authToken,
    contentRoot,
    controlKey,
    metaKey,
    serverIdentityKey,
    scopeCertificateChain,
    keyAttestation,
  });
}

export async function parseViewerOnboardingBundleWire(
  value: unknown,
): Promise<ViewerOnboardingBundleV2> {
  if (typeof value !== "string" || !value.startsWith(WIRE_PREFIX)) {
    reject("bad-prefix", `onboarding bundle must start with ${WIRE_PREFIX}`);
  }
  if (value.length > MAX_WIRE_TEXT_LENGTH) {
    reject("bad-length", "onboarding bundle wire exceeds the transfer size limit");
  }
  const firstDot = value.indexOf(".");
  const secondDot = value.indexOf(".", firstDot + 1);
  if (secondDot < 0 || value.indexOf(".", secondDot + 1) >= 0) {
    reject("bad-encoding", "onboarding bundle wire must contain exactly three segments");
  }
  const encodedBundle = value.slice(firstDot + 1, secondDot);
  const encodedChecksum = value.slice(secondDot + 1);
  if (encodedBundle.length === 0) reject("bad-length", "onboarding bundle payload is empty");
  if (encodedChecksum.length !== Math.ceil((DIGEST_LENGTH * 4) / 3)) {
    reject("bad-length", "onboarding bundle checksum must contain exactly 32 bytes");
  }

  let bytes: Uint8Array;
  let checksum: Uint8Array;
  try {
    bytes = base64urlDecode(encodedBundle);
    checksum = base64urlDecode(encodedChecksum);
  } catch {
    reject("bad-encoding", "onboarding bundle wire must use unpadded base64url");
  }
  if (bytes.byteLength > MAX_CANONICAL_BUNDLE_BYTES) {
    reject("bad-length", "canonical onboarding bundle exceeds the transfer size limit");
  }
  if (
    checksum.byteLength !== DIGEST_LENGTH ||
    base64urlEncode(bytes) !== encodedBundle ||
    base64urlEncode(checksum) !== encodedChecksum
  ) {
    reject("bad-encoding", "onboarding bundle wire must use canonical unpadded base64url");
  }
  const expectedChecksum = await checksumBytes(bytes);
  if (!timingSafeEqual(expectedChecksum, checksum)) {
    reject("bad-checksum", "onboarding bundle checksum does not match its canonical bytes");
  }
  const bundle = decodeCanonicalBundle(bytes);
  if (!timingSafeEqual(encodeBundleParsed(bundle), bytes)) {
    reject("noncanonical-wire", "onboarding bundle bytes do not round-trip canonically");
  }
  return bundle;
}

function sameServerIdentityKey(
  left: ViewerOnboardingServerIdentityKey,
  right: ViewerOnboardingServerIdentityKey,
): boolean {
  return (
    left.identityKeyId === right.identityKeyId &&
    left.algorithm === right.algorithm &&
    left.publicKey === right.publicKey
  );
}

function sameCanonicalDigest(left: string, right: string): boolean {
  return timingSafeEqual(base64urlDecode(left), base64urlDecode(right));
}

function signerBinding(certificate: ServerScopeCertificateRecord): A1Ed25519PublicKeyBinding {
  return {
    identityKeyId: certificate.subjectIdentityKeyId,
    keyGeneration: certificate.keyGeneration,
    algorithm: certificate.subjectKeyAlgorithm,
    publicKey: certificate.subjectPublicKey,
  };
}

function certificateBytesEqual(
  left: ServerScopeCertificateRecord,
  right: ServerScopeCertificateRecord,
): boolean {
  return (
    timingSafeEqual(
      encodeServerScopeCertificatePayload(left),
      encodeServerScopeCertificatePayload(right),
    ) &&
    timingSafeEqual(
      base64urlDecode(left.canonicalPayloadDigest),
      base64urlDecode(right.canonicalPayloadDigest),
    ) &&
    timingSafeEqual(base64urlDecode(left.signature), base64urlDecode(right.signature))
  );
}

function parseOptions(value: VerifyViewerOnboardingBundleOptions): {
  readonly trustedFirstCertificate: ServerScopeCertificateRecord | null;
  readonly expectedServerIdentityKey: ViewerOnboardingServerIdentityKey | null;
} {
  const options = exactRecord(
    {
      trustedFirstCertificate: value.trustedFirstCertificate ?? null,
      expectedServerIdentityKey: value.expectedServerIdentityKey ?? null,
    },
    ["trustedFirstCertificate", "expectedServerIdentityKey"] as const,
    "verifyOptions",
  );
  return {
    trustedFirstCertificate:
      options.trustedFirstCertificate === null
        ? null
        : parseServerScopeCertificateRecord(options.trustedFirstCertificate),
    expectedServerIdentityKey:
      options.expectedServerIdentityKey === null
        ? null
        : parseServerIdentityKey(options.expectedServerIdentityKey),
  };
}

export async function verifyViewerOnboardingBundle(
  value: unknown,
  optionsValue: VerifyViewerOnboardingBundleOptions = {},
): Promise<ViewerOnboardingBundleV2> {
  const bundle =
    typeof value === "string"
      ? await parseViewerOnboardingBundleWire(value)
      : parseViewerOnboardingBundleV2(value);
  const options = parseOptions(optionsValue);
  const authToken = base64urlDecode(bundle.authToken);
  const derivedMachineIdentity = (await sha256(authToken)).slice(0, 16);
  if (toHex(derivedMachineIdentity) !== bundle.machineIdentityId) {
    reject("identity-mismatch", "authToken does not derive the bundle machine identity");
  }

  const certificateIds = new Set<string>();
  const subjectKeyIds = new Set<string>();
  const subjectPublicKeys = new Set<string>();
  for (const certificate of bundle.scopeCertificateChain) {
    if (
      certificate.machineIdentityId !== bundle.machineIdentityId ||
      certificate.collaborationServerId !== bundle.collaborationServerId
    ) {
      reject("certificate-chain-invalid", "certificate scope does not match the bundle scope");
    }
    if (certificateIds.has(certificate.scopeCertificateId)) {
      reject("certificate-chain-invalid", "certificate chain contains a duplicate certificate ID");
    }
    if (subjectKeyIds.has(certificate.subjectIdentityKeyId)) {
      reject("certificate-chain-invalid", "certificate chain redeclares a subject key ID");
    }
    if (subjectPublicKeys.has(certificate.subjectPublicKey)) {
      reject("certificate-chain-invalid", "certificate chain reuses a retired subject public key");
    }
    certificateIds.add(certificate.scopeCertificateId);
    subjectKeyIds.add(certificate.subjectIdentityKeyId);
    subjectPublicKeys.add(certificate.subjectPublicKey);
  }

  const first = bundle.scopeCertificateChain[0];
  if (first === undefined) reject("bad-length", "certificate chain is empty");
  if (options.trustedFirstCertificate === null) {
    if (
      first.supersedesScopeCertificateId !== null ||
      first.signerIdentityKeyId !== first.subjectIdentityKeyId
    ) {
      reject("certificate-chain-invalid", "cold onboarding must begin with a self-signed anchor");
    }
    try {
      await verifyServerScopeCertificate(first, signerBinding(first));
    } catch (error) {
      reject(
        "certificate-chain-invalid",
        `cold onboarding anchor did not verify: ${error instanceof Error ? error.message : "error"}`,
      );
    }
  } else if (!certificateBytesEqual(first, options.trustedFirstCertificate)) {
    reject(
      "certificate-chain-invalid",
      "successor suffix does not begin with the exact locally trusted certificate",
    );
  }

  let previous = first;
  for (let index = 1; index < bundle.scopeCertificateChain.length; index++) {
    const certificate = bundle.scopeCertificateChain[index];
    if (certificate === undefined)
      reject("certificate-chain-invalid", "certificate chain is sparse");
    if (
      certificate.supersedesScopeCertificateId !== previous.scopeCertificateId ||
      certificate.keyGeneration !== previous.keyGeneration + 1 ||
      certificate.signerIdentityKeyId !== previous.subjectIdentityKeyId ||
      certificate.signerSequence <= previous.signerSequence
    ) {
      reject(
        "certificate-chain-invalid",
        `certificate chain item ${index} is not a contiguous successor`,
      );
    }
    try {
      await verifyServerScopeCertificate(certificate, signerBinding(previous));
    } catch (error) {
      reject(
        "certificate-chain-invalid",
        `certificate chain item ${index} did not verify: ${error instanceof Error ? error.message : "error"}`,
      );
    }
    previous = certificate;
  }

  const tipIdentityKey: ViewerOnboardingServerIdentityKey = {
    identityKeyId: previous.subjectIdentityKeyId,
    algorithm: previous.subjectKeyAlgorithm,
    publicKey: previous.subjectPublicKey,
  };
  if (!sameServerIdentityKey(bundle.serverIdentityKey, tipIdentityKey)) {
    reject("key-mismatch", "bundle server identity key does not match the certificate chain tip");
  }
  if (
    options.expectedServerIdentityKey !== null &&
    !sameServerIdentityKey(bundle.serverIdentityKey, options.expectedServerIdentityKey)
  ) {
    reject("key-mismatch", "bundle server identity key does not match the out-of-band pin");
  }

  const attestation = bundle.keyAttestation;
  if (
    attestation.machineIdentityId !== bundle.machineIdentityId ||
    attestation.collaborationServerId !== bundle.collaborationServerId ||
    attestation.scopeCertificateId !== previous.scopeCertificateId ||
    attestation.keyGeneration !== previous.keyGeneration ||
    attestation.signerIdentityKeyId !== previous.subjectIdentityKeyId ||
    attestation.signerSequence <= previous.signerSequence
  ) {
    reject("attestation-mismatch", "onboarding key attestation does not match the chain tip");
  }
  try {
    await verifyViewerOnboardingKeyAttestation(attestation, signerBinding(previous));
  } catch (error) {
    reject(
      "attestation-mismatch",
      `onboarding key attestation did not verify: ${error instanceof Error ? error.message : "error"}`,
    );
  }

  const expectedCommitments = await viewerOnboardingKeyCommitments({
    authToken,
    contentRoot: base64urlDecode(bundle.contentRoot),
    controlKey: base64urlDecode(bundle.controlKey),
    metaKey: base64urlDecode(bundle.metaKey),
  });
  if (
    !sameCanonicalDigest(
      attestation.authTokenCommitment,
      expectedCommitments.authTokenCommitment,
    ) ||
    !sameCanonicalDigest(
      attestation.contentRootCommitment,
      expectedCommitments.contentRootCommitment,
    ) ||
    !sameCanonicalDigest(
      attestation.controlKeyCommitment,
      expectedCommitments.controlKeyCommitment,
    ) ||
    !sameCanonicalDigest(attestation.metaKeyCommitment, expectedCommitments.metaKeyCommitment)
  ) {
    reject("attestation-mismatch", "onboarding key commitments do not match the operational keys");
  }
  return bundle;
}
