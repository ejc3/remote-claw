import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  hkdfExpand,
  hkdfExtract,
  timingSafeEqual,
  utf8,
} from "@remote-claw/clawsec";
import { RuntimeOwnerRpcError } from "./protocol.js";

export const RUNTIME_OWNER_RPC_AUTH_KDF_DOMAIN = "remote-claw/runtime-owner-rpc-auth/v1" as const;
export const RUNTIME_OWNER_RPC_SERVER_PROOF_DOMAIN =
  "remote-claw/runtime-owner-rpc-auth-proof/server/v1" as const;
export const RUNTIME_OWNER_RPC_CLIENT_PROOF_DOMAIN =
  "remote-claw/runtime-owner-rpc-auth-proof/client/v1" as const;

const MACHINE_IDENTITY = /^[0-9a-f]{32}$/;
const SECRET_BYTES = 32;
const CHALLENGE_BYTES = 32;
const PROOF_BYTES = 32;
const ABSTRACT_SOCKET_PREFIX = "remote-claw.runtime-owner.v1.";

export type RuntimeOwnerRpcRandomBytes = (length: number) => Uint8Array;

function parseMachineIdentityId(value: unknown): string {
  if (typeof value !== "string" || !MACHINE_IDENTITY.test(value)) {
    throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
  }
  return value;
}

function decodeCanonical(value: string, bytes: number): Uint8Array {
  if (value.length !== Math.ceil((bytes * 4) / 3)) {
    throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
  }
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(value);
  } catch {
    throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
  }
  if (decoded.length !== bytes || base64urlEncode(decoded) !== value) {
    throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
  }
  return decoded;
}

function copyIdentitySecret(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== SECRET_BYTES) {
    throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
  }
  return Uint8Array.from(value);
}

function hmac(key: Uint8Array, payload: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(payload).digest());
}

export function assertRuntimeOwnerRpcPlatform(): void {
  if (process.platform !== "linux") throw new RuntimeOwnerRpcError("UNAVAILABLE");
}

/** Linux abstract namespace: no filesystem entry exists to replace or symlink-race. */
export function runtimeOwnerRpcSocketAddress(machineIdentityId: string): string {
  const identity = parseMachineIdentityId(machineIdentityId);
  return `\0${ABSTRACT_SOCKET_PREFIX}${identity}`;
}

/**
 * Holds the derived key without exposing a getter. The input identity secret and HKDF PRK are copied
 * only for derivation and zeroed before this factory returns.
 */
export class RuntimeOwnerRpcAuthenticator {
  readonly #machineIdentity: Uint8Array;
  readonly #key: Uint8Array;
  #closed = false;

  private constructor(machineIdentityId: string, key: Uint8Array) {
    this.#machineIdentity = utf8(machineIdentityId);
    this.#key = key;
  }

  static async create(
    machineIdentityId: string,
    identitySecret: Uint8Array,
  ): Promise<RuntimeOwnerRpcAuthenticator> {
    const identity = parseMachineIdentityId(machineIdentityId);
    const secret = copyIdentitySecret(identitySecret);
    let prk: Uint8Array | undefined;
    try {
      prk = await hkdfExtract(new Uint8Array(0), secret);
      const key = await hkdfExpand(prk, utf8(RUNTIME_OWNER_RPC_AUTH_KDF_DOMAIN), SECRET_BYTES);
      return new RuntimeOwnerRpcAuthenticator(identity, key);
    } finally {
      secret.fill(0);
      prk?.fill(0);
    }
  }

  createChallenge(
    randomBytes: RuntimeOwnerRpcRandomBytes = (length) => nodeRandomBytes(length),
  ): Readonly<{ challenge: string; serverProof: string }> {
    this.#assertOpen();
    const challenge = randomBytes(CHALLENGE_BYTES);
    if (!(challenge instanceof Uint8Array) || challenge.length !== CHALLENGE_BYTES) {
      throw new RuntimeOwnerRpcError("UNAVAILABLE");
    }
    const challengeCopy = Uint8Array.from(challenge);
    try {
      return Object.freeze({
        challenge: base64urlEncode(challengeCopy),
        serverProof: base64urlEncode(
          this.#proof(RUNTIME_OWNER_RPC_SERVER_PROOF_DOMAIN, challengeCopy),
        ),
      });
    } finally {
      challengeCopy.fill(0);
    }
  }

  verifyServerProof(challenge: string, proof: string): boolean {
    return this.#verify(RUNTIME_OWNER_RPC_SERVER_PROOF_DOMAIN, challenge, proof);
  }

  createClientProof(challenge: string): string {
    this.#assertOpen();
    const challengeBytes = decodeCanonical(challenge, CHALLENGE_BYTES);
    try {
      return base64urlEncode(this.#proof(RUNTIME_OWNER_RPC_CLIENT_PROOF_DOMAIN, challengeBytes));
    } finally {
      challengeBytes.fill(0);
    }
  }

  verifyClientProof(challenge: string, proof: string): boolean {
    return this.#verify(RUNTIME_OWNER_RPC_CLIENT_PROOF_DOMAIN, challenge, proof);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#key.fill(0);
    this.#machineIdentity.fill(0);
  }

  #assertOpen(): void {
    if (this.#closed) throw new RuntimeOwnerRpcError("CLOSED");
  }

  #proof(domain: string, challenge: Uint8Array): Uint8Array {
    this.#assertOpen();
    return hmac(this.#key, concatBytes(utf8(domain), this.#machineIdentity, challenge));
  }

  #verify(domain: string, challenge: string, proof: string): boolean {
    this.#assertOpen();
    let challengeBytes: Uint8Array;
    let proofBytes: Uint8Array;
    try {
      challengeBytes = decodeCanonical(challenge, CHALLENGE_BYTES);
      proofBytes = decodeCanonical(proof, PROOF_BYTES);
    } catch {
      return false;
    }
    try {
      const expected = this.#proof(domain, challengeBytes);
      try {
        return timingSafeEqual(expected, proofBytes);
      } finally {
        expected.fill(0);
      }
    } finally {
      challengeBytes.fill(0);
      proofBytes.fill(0);
    }
  }
}
