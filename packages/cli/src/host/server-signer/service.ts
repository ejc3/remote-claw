import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
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
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseMachineIdentityId,
} from "../state/ids.js";
import { ProtectedByteSnapshot } from "../state/protected.js";
import {
  deriveServerIdentityKeyId,
  SERVER_IDENTITY_KEY_ID_DOMAIN,
  SERVER_KEY_WRAP_SCHEMA_ID,
} from "../state/server-signing.js";
import type {
  ReconcileInitialServerSignerRequest,
  ServerSignerBootstrapReconciliation,
  ServerSigningRepositoryOperations,
} from "../state/server-signing-repository.js";

export { deriveServerIdentityKeyId, SERVER_IDENTITY_KEY_ID_DOMAIN, SERVER_KEY_WRAP_SCHEMA_ID };
export const SERVER_KEY_WRAP_KDF_DOMAIN = "remote-claw/server-key-wrap-kdf/v1" as const;
export const SERVER_KEY_SELF_TEST_DOMAIN = "remote-claw/server-key-self-test/v1" as const;

const ROOT_SECRET_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
const WRAP_KEY_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const MAX_PKCS8_BYTES = 1_024;

export interface ServerKeyBinding {
  readonly machineIdentityId: string;
  readonly collaborationServerId: CollaborationServerId;
  readonly identityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly algorithm: "Ed25519";
  readonly publicKey: string;
  readonly signingKeyRef: ProtectedHandleId;
  readonly custodyBackend: "owned-file";
}

/** Ciphertext-only representation suitable for the durable server-key envelope row. */
export interface WrappedServerPrivateKey {
  readonly wrappingSchemaId: typeof SERVER_KEY_WRAP_SCHEMA_ID;
  readonly binding: ServerKeyBinding;
  readonly wrapNonce: ProtectedByteSnapshot;
  readonly wrappedPkcs8: ProtectedByteSnapshot;
  readonly authTag: ProtectedByteSnapshot;
  readonly pkcs8Digest: A1Digest;
}

/** Narrow process-lifetime capability. It never exports a root secret, wrap key, or PKCS#8. */
export interface ServerKeyCustodySigningCapability {
  generateIdentityKey(
    machineIdentityId: string,
    collaborationServerId: CollaborationServerId,
    signingKeyRef: ProtectedHandleId,
    keyGeneration: number,
  ): WrappedServerPrivateKey;
  sign(
    envelope: WrappedServerPrivateKey,
    canonicalPayload: ProtectedByteSnapshot,
  ): ProtectedByteSnapshot;
  assertUsable(envelope: WrappedServerPrivateKey): void;
}

export interface ServerKeyCustodySigner extends ServerKeyCustodySigningCapability {
  readonly closed: boolean;
  close(): void;
}

export interface InitialServerSignerBootstrapRequest {
  readonly machineIdentityId: string;
  readonly collaborationServerId: CollaborationServerId;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly bootstrapSigningLeaseId: A1SafeId;
  readonly signingLeaseId: A1SafeId;
  readonly signingKeyRef: ProtectedHandleId;
  readonly scopeCertificateId: A1SafeId;
  readonly preparedAtMs: number;
  readonly issuedAtMs: number;
  readonly expectedServerSignatureSeq: 0;
  readonly expectedFencingToken: 0;
}

function requireFixedBytes(value: Uint8Array, byteLength: number, field: string): Uint8Array {
  const snapshot = canonicalByteSnapshot(value);
  if (snapshot.byteLength !== byteLength) {
    snapshot.fill(0);
    throw new TypeError(`${field} must contain exactly ${byteLength} bytes`);
  }
  return snapshot;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function digest(bytes: Uint8Array): A1Digest {
  return parseA1Digest(base64urlEncode(createHash("sha256").update(bytes).digest()));
}

function canonicalBinding(binding: ServerKeyBinding): ServerKeyBinding {
  const machineIdentityId = parseMachineIdentityId(
    binding.machineIdentityId,
    "serverKeyBinding.machineIdentityId",
  );
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    binding.collaborationServerId,
    "serverKeyBinding.collaborationServerId",
  );
  const identityKeyId = parseA1SafeId(binding.identityKeyId, "serverKeyBinding.identityKeyId");
  const keyGeneration = positiveSafeInteger(
    binding.keyGeneration,
    "serverKeyBinding.keyGeneration",
  );
  const signingKeyRef = parseA1CanonicalId(
    "protectedHandle",
    binding.signingKeyRef,
    "serverKeyBinding.signingKeyRef",
  );
  if (binding.custodyBackend !== "owned-file") {
    throw new TypeError('serverKeyBinding.custodyBackend must equal "owned-file"');
  }
  if (binding.algorithm !== "Ed25519") {
    throw new TypeError('serverKeyBinding.algorithm must equal "Ed25519"');
  }
  const publicKeyBytes = requireFixedBytes(
    base64urlDecode(binding.publicKey),
    PUBLIC_KEY_BYTES,
    "serverKeyBinding.publicKey",
  );
  try {
    if (base64urlEncode(publicKeyBytes) !== binding.publicKey) {
      throw new TypeError("serverKeyBinding.publicKey must use canonical unpadded base64url");
    }
  } finally {
    publicKeyBytes.fill(0);
  }
  return Object.freeze({
    machineIdentityId,
    collaborationServerId,
    identityKeyId,
    keyGeneration,
    algorithm: binding.algorithm,
    publicKey: binding.publicKey,
    signingKeyRef,
    custodyBackend: binding.custodyBackend,
  });
}

/** Canonical AES-GCM AAD for deterministic contract vectors and independent verification. */
export function canonicalServerKeyBindingAad(
  bindingInput: ServerKeyBinding,
  pkcs8DigestInput: A1Digest,
): Uint8Array {
  const binding = canonicalBinding(bindingInput);
  const pkcs8Digest = parseA1Digest(pkcs8DigestInput, "pkcs8Digest");
  const publicKey = base64urlDecode(binding.publicKey);
  const pkcs8DigestBytes = base64urlDecode(pkcs8Digest);
  try {
    const writer = new CanonicalWriter();
    writer.str(SERVER_KEY_WRAP_SCHEMA_ID);
    writer.bytes(Buffer.from(binding.machineIdentityId, "hex"));
    writer.str(binding.collaborationServerId);
    writer.str(binding.identityKeyId);
    writer.uint(binding.keyGeneration);
    writer.str(binding.algorithm);
    writer.str(binding.signingKeyRef);
    writer.str(binding.custodyBackend);
    writer.bytes(publicKey);
    writer.bytes(pkcs8DigestBytes);
    return writer.finish();
  } finally {
    publicKey.fill(0);
    pkcs8DigestBytes.fill(0);
  }
}

function deriveWrapKey(rootSecret: Uint8Array): Buffer {
  const secret = requireFixedBytes(rootSecret, ROOT_SECRET_BYTES, "rootSecret");
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        Buffer.alloc(0),
        Buffer.from(SERVER_KEY_WRAP_KDF_DOMAIN, "utf8"),
        WRAP_KEY_BYTES,
      ),
    );
  } finally {
    secret.fill(0);
  }
}

function wrapPkcs8WithKey(
  wrapKey: Uint8Array,
  bindingInput: ServerKeyBinding,
  pkcs8Input: Uint8Array,
): WrappedServerPrivateKey {
  const binding = canonicalBinding(bindingInput);
  const pkcs8 = canonicalByteSnapshot(pkcs8Input);
  if (pkcs8.byteLength === 0 || pkcs8.byteLength > MAX_PKCS8_BYTES) {
    pkcs8.fill(0);
    throw new TypeError(`PKCS#8 bytes must contain 1-${MAX_PKCS8_BYTES} bytes`);
  }
  let pkcs8Digest: A1Digest | undefined;
  let nonce: Buffer | undefined;
  let aad: Uint8Array | undefined;
  let ciphertext: Buffer | undefined;
  let updateChunk: Buffer | undefined;
  let finalChunk: Buffer | undefined;
  let tag: Buffer | undefined;
  try {
    pkcs8Digest = digest(pkcs8);
    nonce = randomBytes(WRAP_NONCE_BYTES);
    aad = canonicalServerKeyBindingAad(binding, pkcs8Digest);
    const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce, {
      authTagLength: WRAP_TAG_BYTES,
    });
    cipher.setAAD(aad, { plaintextLength: pkcs8.byteLength });
    updateChunk = cipher.update(pkcs8);
    finalChunk = cipher.final();
    ciphertext = Buffer.concat([updateChunk, finalChunk]);
    tag = cipher.getAuthTag();
    return Object.freeze({
      wrappingSchemaId: SERVER_KEY_WRAP_SCHEMA_ID,
      binding,
      wrapNonce: ProtectedByteSnapshot.from(nonce),
      wrappedPkcs8: ProtectedByteSnapshot.from(ciphertext),
      authTag: ProtectedByteSnapshot.from(tag),
      pkcs8Digest,
    });
  } finally {
    aad?.fill(0);
    ciphertext?.fill(0);
    updateChunk?.fill(0);
    finalChunk?.fill(0);
    tag?.fill(0);
    nonce?.fill(0);
    pkcs8.fill(0);
  }
}

function unwrapPrivateKey(wrapKey: Uint8Array, envelope: WrappedServerPrivateKey): KeyObject {
  if (envelope.wrappingSchemaId !== SERVER_KEY_WRAP_SCHEMA_ID) {
    throw new TypeError("server private-key wrapping schema is unsupported");
  }
  const binding = canonicalBinding(envelope.binding);
  let nonce: Uint8Array | undefined;
  let tag: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  let aad: Uint8Array | undefined;
  let plaintext: Buffer | undefined;
  let updateChunk: Buffer | undefined;
  let finalChunk: Buffer | undefined;
  try {
    nonce = requireFixedBytes(envelope.wrapNonce.copyBytes(), WRAP_NONCE_BYTES, "wrapNonce");
    tag = requireFixedBytes(envelope.authTag.copyBytes(), WRAP_TAG_BYTES, "authTag");
    ciphertext = envelope.wrappedPkcs8.copyBytes();
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_PKCS8_BYTES) {
      throw new TypeError("wrappedPkcs8 has an invalid byte length");
    }
    const expectedDigest = parseA1Digest(envelope.pkcs8Digest, "pkcs8Digest");
    aad = canonicalServerKeyBindingAad(binding, expectedDigest);
    const decipher = createDecipheriv("aes-256-gcm", wrapKey, nonce, {
      authTagLength: WRAP_TAG_BYTES,
    });
    decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
    decipher.setAuthTag(tag);
    updateChunk = decipher.update(ciphertext);
    finalChunk = decipher.final();
    plaintext = Buffer.concat([updateChunk, finalChunk]);
    if (digest(plaintext) !== expectedDigest) {
      throw new Error("server private-key plaintext digest does not match its binding");
    }
    return createPrivateKey({ key: plaintext, format: "der", type: "pkcs8" });
  } finally {
    plaintext?.fill(0);
    updateChunk?.fill(0);
    finalChunk?.fill(0);
    aad?.fill(0);
    nonce?.fill(0);
    tag?.fill(0);
    ciphertext?.fill(0);
  }
}

function signWithKey(
  wrapKey: Uint8Array,
  envelope: WrappedServerPrivateKey,
  canonicalPayload: Uint8Array,
): Buffer {
  return sign(null, canonicalPayload, unwrapPrivateKey(wrapKey, envelope));
}

class DerivedWrapKeyServerSigner implements ServerKeyCustodySigner {
  readonly #wrapKey: Buffer;
  #closed = false;

  constructor(wrapKey: Buffer) {
    this.#wrapKey = wrapKey;
  }

  get closed(): boolean {
    return this.#closed;
  }

  generateIdentityKey(
    machineIdentityIdInput: string,
    collaborationServerIdInput: CollaborationServerId,
    signingKeyRefInput: ProtectedHandleId,
    keyGenerationInput: number,
  ): WrappedServerPrivateKey {
    this.#assertOpen();
    const machineIdentityId = parseMachineIdentityId(machineIdentityIdInput);
    const collaborationServerId = parseA1CanonicalId(
      "collaborationServer",
      collaborationServerIdInput,
    );
    const keyGeneration = positiveSafeInteger(keyGenerationInput, "keyGeneration");
    const signingKeyRef = parseA1CanonicalId(
      "protectedHandle",
      signingKeyRefInput,
      "signingKeyRef",
    );
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" });
    if (publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519" || typeof publicJwk.x !== "string") {
      throw new Error("Node did not return a canonical Ed25519 public key");
    }
    const publicBytes = requireFixedBytes(
      base64urlDecode(publicJwk.x),
      PUBLIC_KEY_BYTES,
      "publicKey",
    );
    let binding: ServerKeyBinding;
    try {
      binding = Object.freeze({
        machineIdentityId,
        collaborationServerId,
        identityKeyId: deriveServerIdentityKeyId(
          machineIdentityId,
          collaborationServerId,
          keyGeneration,
          publicBytes,
        ),
        keyGeneration,
        algorithm: "Ed25519",
        publicKey: base64urlEncode(publicBytes),
        signingKeyRef,
        custodyBackend: "owned-file",
      });
    } finally {
      publicBytes.fill(0);
    }
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    try {
      return wrapPkcs8WithKey(this.#wrapKey, binding, pkcs8);
    } finally {
      pkcs8.fill(0);
    }
  }

  sign(
    envelope: WrappedServerPrivateKey,
    canonicalPayload: ProtectedByteSnapshot,
  ): ProtectedByteSnapshot {
    this.#assertOpen();
    const payload = canonicalPayload.copyBytes();
    let signature: Buffer | undefined;
    try {
      signature = signWithKey(this.#wrapKey, envelope, payload);
      return ProtectedByteSnapshot.from(signature);
    } finally {
      signature?.fill(0);
      payload.fill(0);
    }
  }

  assertUsable(envelope: WrappedServerPrivateKey): void {
    this.#assertOpen();
    const binding = canonicalBinding(envelope.binding);
    const writer = new CanonicalWriter();
    writer.str(SERVER_KEY_SELF_TEST_DOMAIN);
    writer.bytes(Buffer.from(binding.machineIdentityId, "hex"));
    writer.str(binding.collaborationServerId);
    writer.str(binding.identityKeyId);
    writer.uint(binding.keyGeneration);
    writer.str(binding.algorithm);
    writer.str(binding.signingKeyRef);
    writer.str(binding.custodyBackend);
    const publicKeyBytes = base64urlDecode(binding.publicKey);
    writer.bytes(publicKeyBytes);
    publicKeyBytes.fill(0);
    const payload = writer.finish();
    let signature: Buffer | undefined;
    let valid = false;
    try {
      signature = signWithKey(this.#wrapKey, envelope, payload);
      valid = verify(
        null,
        payload,
        { key: { kty: "OKP", crv: "Ed25519", x: binding.publicKey }, format: "jwk" },
        signature,
      );
    } finally {
      signature?.fill(0);
      payload.fill(0);
    }
    if (!valid) throw new Error("wrapped server private key does not match its public key");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wrapKey.fill(0);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("server custody signer is closed");
  }
}

/** Derive once; the returned signer retains only the wrap key and must be closed by its owner. */
export function createServerKeyCustodySigner(rootSecret: Uint8Array): ServerKeyCustodySigner {
  const wrapKey = deriveWrapKey(rootSecret);
  try {
    return new DerivedWrapKeyServerSigner(wrapKey);
  } catch (error) {
    wrapKey.fill(0);
    throw error;
  }
}

/** Reconcile durable phase evidence, then admit writability only after custody self-verification. */
export function reconcileUsableInitialServerSigner(
  custody: ServerKeyCustodySigningCapability,
  repository: ServerSigningRepositoryOperations,
  request: ReconcileInitialServerSignerRequest,
): ServerSignerBootstrapReconciliation | null {
  const reconciliation = repository.reconcileInitialBootstrap(request);
  if (reconciliation === null || !reconciliation.authorityCurrent) return reconciliation;
  const wrapped: WrappedServerPrivateKey = Object.freeze({
    wrappingSchemaId: reconciliation.privateKeyEnvelope.wrappingSchemaId,
    binding: Object.freeze({
      machineIdentityId: request.prepare.bootstrapIntent.machineIdentityId,
      collaborationServerId: reconciliation.identityKey.collaborationServerId,
      identityKeyId: reconciliation.identityKey.identityKeyId,
      keyGeneration: reconciliation.identityKey.keyGeneration,
      algorithm: "Ed25519",
      publicKey: reconciliation.identityKey.publicKey,
      signingKeyRef: reconciliation.identityKey.signingKeyRef,
      custodyBackend: "owned-file",
    }),
    wrapNonce: reconciliation.privateKeyEnvelope.wrapNonce,
    wrappedPkcs8: reconciliation.privateKeyEnvelope.wrappedPkcs8,
    authTag: reconciliation.privateKeyEnvelope.authTag,
    pkcs8Digest: reconciliation.privateKeyEnvelope.pkcs8Digest,
  });
  try {
    custody.assertUsable(wrapped);
    return Object.freeze({
      ...reconciliation,
      writable: true,
      nonWritableReason: null,
    });
  } catch {
    return Object.freeze({
      ...reconciliation,
      writable: false,
      nonWritableReason: "unusable_key_custody",
    });
  }
}
