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
  type NativeRuntimeId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "../state/ids.js";
import { ProtectedByteSnapshot } from "../state/protected.js";

export const RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID =
  "remote-claw/runtime-owner-key-wrap/aes-256-gcm/v1" as const;
export const RUNTIME_OWNER_KEY_ID_DOMAIN = "remote-claw/runtime-owner-identity-key-id/v1";
export const RUNTIME_OWNER_KEY_WRAP_KDF_DOMAIN = "remote-claw/runtime-owner-key-wrap-kdf/v1";
export const RUNTIME_OWNER_KEY_SELF_TEST_DOMAIN = "remote-claw/runtime-owner-key-self-test/v1";

const ROOT_SECRET_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
const WRAP_KEY_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const MAX_PKCS8_BYTES = 1_024;

export interface RuntimeOwnerKeyBinding {
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly publicKey: string;
}

/** Ciphertext-only SQLite custody envelope. No API exposes its PKCS#8 plaintext. */
export interface WrappedRuntimeOwnerPrivateKey {
  readonly wrappingSchemaId: typeof RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID;
  readonly binding: RuntimeOwnerKeyBinding;
  readonly wrapNonce: ProtectedByteSnapshot;
  readonly wrappedPkcs8: ProtectedByteSnapshot;
  readonly authTag: ProtectedByteSnapshot;
  readonly pkcs8Digest: A1Digest;
}

/** Narrow daemon-lifetime capability. It never exports a root secret, wrap key, or private key. */
export interface RuntimeOwnerKeyCustodySigningCapability {
  sign(
    envelope: WrappedRuntimeOwnerPrivateKey,
    canonicalPayload: ProtectedByteSnapshot,
  ): ProtectedByteSnapshot;
  assertUsable(envelope: WrappedRuntimeOwnerPrivateKey): void;
}

/** Service-owned lifecycle handle; callers receive only its narrower signing view. */
export interface RuntimeOwnerKeyCustodySigner extends RuntimeOwnerKeyCustodySigningCapability {
  readonly closed: boolean;
  close(): void;
}

function requireFixedBytes(value: Uint8Array, byteLength: number, field: string): Uint8Array {
  const snapshot = canonicalByteSnapshot(value);
  if (snapshot.byteLength !== byteLength) {
    snapshot.fill(0);
    throw new TypeError(`${field} must contain exactly ${byteLength} bytes`);
  }
  return snapshot;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function digest(bytes: Uint8Array): A1Digest {
  return parseA1Digest(base64urlEncode(createHash("sha256").update(bytes).digest()));
}

function canonicalBinding(binding: RuntimeOwnerKeyBinding): RuntimeOwnerKeyBinding {
  const runtimeId = parseA1CanonicalId("nativeRuntime", binding.runtimeId);
  const runtimeOwnerIdentityKeyId = parseA1SafeId(
    binding.runtimeOwnerIdentityKeyId,
    "runtimeOwnerIdentityKeyId",
  );
  const keyGeneration = requirePositiveSafeInteger(binding.keyGeneration, "keyGeneration");
  const publicKeyBytes = requireFixedBytes(
    base64urlDecode(binding.publicKey),
    PUBLIC_KEY_BYTES,
    "publicKey",
  );
  if (base64urlEncode(publicKeyBytes) !== binding.publicKey) {
    throw new TypeError("publicKey must use canonical unpadded base64url");
  }
  return Object.freeze({
    runtimeId,
    runtimeOwnerIdentityKeyId,
    keyGeneration,
    publicKey: binding.publicKey,
  });
}

function bindingAad(binding: RuntimeOwnerKeyBinding, pkcs8Digest: A1Digest): Uint8Array {
  const writer = new CanonicalWriter();
  writer.str(RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID);
  writer.str(binding.runtimeId);
  writer.str(binding.runtimeOwnerIdentityKeyId);
  writer.uint(binding.keyGeneration);
  writer.bytes(base64urlDecode(binding.publicKey));
  writer.bytes(base64urlDecode(pkcs8Digest));
  return writer.finish();
}

function deriveWrapKey(rootSecret: Uint8Array): Buffer {
  const secret = requireFixedBytes(rootSecret, ROOT_SECRET_BYTES, "rootSecret");
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        Buffer.alloc(0),
        Buffer.from(RUNTIME_OWNER_KEY_WRAP_KDF_DOMAIN, "utf8"),
        WRAP_KEY_BYTES,
      ),
    );
  } finally {
    secret.fill(0);
  }
}

function keyId(runtimeId: NativeRuntimeId, generation: number, publicKey: Uint8Array): A1SafeId {
  const writer = new CanonicalWriter();
  writer.str(RUNTIME_OWNER_KEY_ID_DOMAIN);
  writer.str(runtimeId);
  writer.uint(generation);
  writer.bytes(publicKey);
  return parseA1SafeId(
    `roik_${base64urlEncode(createHash("sha256").update(writer.finish()).digest())}`,
  );
}

function wrapPkcs8WithKey(
  wrapKey: Uint8Array,
  binding: RuntimeOwnerKeyBinding,
  pkcs8Input: Uint8Array,
): WrappedRuntimeOwnerPrivateKey {
  const canonical = canonicalBinding(binding);
  const pkcs8 = canonicalByteSnapshot(pkcs8Input);
  if (pkcs8.byteLength === 0 || pkcs8.byteLength > MAX_PKCS8_BYTES) {
    pkcs8.fill(0);
    throw new TypeError(`PKCS#8 bytes must contain 1-${MAX_PKCS8_BYTES} bytes`);
  }
  const pkcs8Digest = digest(pkcs8);
  const nonce = randomBytes(WRAP_NONCE_BYTES);
  let ciphertext: Buffer | undefined;
  let tag: Buffer | undefined;
  try {
    const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce, {
      authTagLength: WRAP_TAG_BYTES,
    });
    cipher.setAAD(bindingAad(canonical, pkcs8Digest), { plaintextLength: pkcs8.byteLength });
    ciphertext = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
    tag = cipher.getAuthTag();
    return Object.freeze({
      wrappingSchemaId: RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID,
      binding: canonical,
      wrapNonce: ProtectedByteSnapshot.from(nonce),
      wrappedPkcs8: ProtectedByteSnapshot.from(ciphertext),
      authTag: ProtectedByteSnapshot.from(tag),
      pkcs8Digest,
    });
  } finally {
    ciphertext?.fill(0);
    tag?.fill(0);
    nonce.fill(0);
    pkcs8.fill(0);
  }
}

function unwrapKeyWithKey(wrapKey: Uint8Array, envelope: WrappedRuntimeOwnerPrivateKey): KeyObject {
  if (envelope.wrappingSchemaId !== RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID) {
    throw new TypeError("runtime-owner private key wrapping schema is unsupported");
  }
  const binding = canonicalBinding(envelope.binding);
  let nonce: Uint8Array | undefined;
  let tag: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  let plaintext: Buffer | undefined;
  try {
    nonce = requireFixedBytes(envelope.wrapNonce.copyBytes(), WRAP_NONCE_BYTES, "wrapNonce");
    tag = requireFixedBytes(envelope.authTag.copyBytes(), WRAP_TAG_BYTES, "authTag");
    ciphertext = envelope.wrappedPkcs8.copyBytes();
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_PKCS8_BYTES) {
      throw new TypeError("wrappedPkcs8 has an invalid byte length");
    }
    const expectedDigest = parseA1Digest(envelope.pkcs8Digest, "pkcs8Digest");
    const decipher = createDecipheriv("aes-256-gcm", wrapKey, nonce, {
      authTagLength: WRAP_TAG_BYTES,
    });
    decipher.setAAD(bindingAad(binding, expectedDigest), {
      plaintextLength: ciphertext.byteLength,
    });
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (digest(plaintext) !== expectedDigest) {
      throw new Error("runtime-owner private key plaintext digest does not match its binding");
    }
    return createPrivateKey({ key: plaintext, format: "der", type: "pkcs8" });
  } finally {
    plaintext?.fill(0);
    nonce?.fill(0);
    tag?.fill(0);
    ciphertext?.fill(0);
  }
}

/** Generate a runtime-scoped Ed25519 key and return only its public metadata and wrapped custody. */
export function generateWrappedRuntimeOwnerIdentityKey(
  rootSecret: Uint8Array,
  runtimeIdInput: NativeRuntimeId,
  keyGenerationInput: number,
): WrappedRuntimeOwnerPrivateKey {
  const runtimeId = parseA1CanonicalId("nativeRuntime", runtimeIdInput);
  const keyGeneration = requirePositiveSafeInteger(keyGenerationInput, "keyGeneration");
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
  const binding = Object.freeze({
    runtimeId,
    runtimeOwnerIdentityKeyId: keyId(runtimeId, keyGeneration, publicBytes),
    keyGeneration,
    publicKey: base64urlEncode(publicBytes),
  });
  publicBytes.fill(0);
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  let wrapKey: Buffer | undefined;
  try {
    wrapKey = deriveWrapKey(rootSecret);
    return wrapPkcs8WithKey(wrapKey, binding, pkcs8);
  } finally {
    wrapKey?.fill(0);
    pkcs8.fill(0);
  }
}

function signBytesWithKey(
  wrapKey: Uint8Array,
  envelope: WrappedRuntimeOwnerPrivateKey,
  canonicalPayload: Uint8Array,
): Buffer {
  const privateKey = unwrapKeyWithKey(wrapKey, envelope);
  return sign(null, canonicalPayload, privateKey);
}

class DerivedWrapKeyRuntimeOwnerSigner implements RuntimeOwnerKeyCustodySigner {
  readonly #wrapKey: Buffer;
  #closed = false;

  constructor(wrapKey: Buffer) {
    this.#wrapKey = wrapKey;
  }

  get closed(): boolean {
    return this.#closed;
  }

  sign(
    envelope: WrappedRuntimeOwnerPrivateKey,
    canonicalPayload: ProtectedByteSnapshot,
  ): ProtectedByteSnapshot {
    this.#assertOpen();
    const payload = canonicalPayload.copyBytes();
    let signature: Buffer | undefined;
    try {
      signature = signBytesWithKey(this.#wrapKey, envelope, payload);
      return ProtectedByteSnapshot.from(signature);
    } finally {
      signature?.fill(0);
      payload.fill(0);
    }
  }

  assertUsable(envelope: WrappedRuntimeOwnerPrivateKey): void {
    this.#assertOpen();
    const binding = canonicalBinding(envelope.binding);
    const writer = new CanonicalWriter();
    writer.str(RUNTIME_OWNER_KEY_SELF_TEST_DOMAIN);
    writer.str(binding.runtimeId);
    writer.str(binding.runtimeOwnerIdentityKeyId);
    writer.uint(binding.keyGeneration);
    writer.bytes(base64urlDecode(binding.publicKey));
    const payload = writer.finish();
    let signature: Buffer | undefined;
    let valid = false;
    try {
      signature = signBytesWithKey(this.#wrapKey, envelope, payload);
      valid = verify(
        null,
        payload,
        {
          key: { kty: "OKP", crv: "Ed25519", x: binding.publicKey },
          format: "jwk",
        },
        signature,
      );
    } finally {
      signature?.fill(0);
      payload.fill(0);
    }
    if (!valid) throw new Error("runtime-owner wrapped private key does not match its public key");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wrapKey.fill(0);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("runtime-owner custody signer is closed");
  }
}

/** Derive once; the returned signer retains only the wrap key and must be closed by its owner. */
export function createRuntimeOwnerKeyCustodySigner(
  rootSecret: Uint8Array,
): RuntimeOwnerKeyCustodySigner {
  const wrapKey = deriveWrapKey(rootSecret);
  try {
    return new DerivedWrapKeyRuntimeOwnerSigner(wrapKey);
  } catch (error) {
    wrapKey.fill(0);
    throw error;
  }
}

/** Compatibility one-shot: the daemon service should retain one signer instead. */
export function signWithWrappedRuntimeOwnerIdentityKey(
  rootSecret: Uint8Array,
  envelope: WrappedRuntimeOwnerPrivateKey,
  canonicalPayload: ProtectedByteSnapshot,
): ProtectedByteSnapshot {
  const signer = createRuntimeOwnerKeyCustodySigner(rootSecret);
  try {
    return signer.sign(envelope, canonicalPayload);
  } finally {
    signer.close();
  }
}

/** Compatibility one-shot: prove the private/public binding and immediately erase the wrap key. */
export function assertWrappedRuntimeOwnerIdentityKeyUsable(
  rootSecret: Uint8Array,
  envelope: WrappedRuntimeOwnerPrivateKey,
): void {
  const signer = createRuntimeOwnerKeyCustodySigner(rootSecret);
  try {
    signer.assertUsable(envelope);
  } finally {
    signer.close();
  }
}
