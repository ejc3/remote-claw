// §2A the security provider: one seam between the wrapper/web app and the crypto, with swappable
// trust levels chosen by config. The wire format and the broker are byte-identical across levels —
// only seal/open differ. clawsec supplies the primitives (seal/open/deriveSessionKey); this is the
// thin orchestration that selects the per-plane key and, for Open, skips encryption.
//
//   Open   — NO encryption: frames ride in the clear, so the relay sees AND can forge everything.
//            For local dev or a server you fully trust. Never a silent default (the caller chooses).
//   Sealed — E2E: per-message AES-256-GCM under the plane key (content / control / meta). The relay
//            sees only ciphertext + the cleartext routing header.
//   Managed — (future) Sealed + the relay delivers wrapped keys to devices; NOT implemented here.
//
// Addressing/admission is identical at every level: authBearer() is auth_token, which the broker
// recomputes identity_id from (§4.5). Open trusts the server for CONTENT, not for routing.

import {
  deriveSessionKey,
  type Frame,
  type FrameHeader,
  type Identity,
  open,
  seal,
} from "@remote-claw/clawsec";

/** The three message planes; each is sealed under its own key (§4.3). */
export type Plane = "session" | "control" | "meta";

/** The trust level. "managed" (server-relayed wrapped keys) is future and not built here. */
export type Level = "open" | "sealed";

export interface SecurityProvider {
  readonly level: Level;
  /** The bearer presented to the broker; it self-verifies identity_id from this (§4.5). */
  authBearer(): Uint8Array;
  /**
   * Seal a plaintext frame on `plane`: session → K_session (per header.sessionId), control →
   * control_key, meta → K_meta. Returns a wire Frame the broker routes by its cleartext header.
   */
  sealFrame(plane: Plane, header: FrameHeader, plaintext: Uint8Array): Promise<Frame>;
  /**
   * Open a frame to its plaintext. Sealed verifies the AEAD tag and throws (AeadError) on a
   * tampered frame OR a non-AEAD (Open) frame — so a Sealed client never silently reads plaintext.
   */
  openFrame(plane: Plane, frame: Frame): Promise<Uint8Array>;
}

/** Sealed (E2E): per-message AES-256-GCM under the plane key. */
class SealedProvider implements SecurityProvider {
  readonly level = "sealed" as const;
  readonly #identity: Identity;
  /** K_session is derived once per session_id and reused (a stable per-session key). */
  readonly #sessionKeys = new Map<string, Uint8Array>();

  constructor(identity: Identity) {
    this.#identity = identity;
  }

  authBearer(): Uint8Array {
    // Hand back a copy: the bearer is caller-owned and the identity's key must stay immutable.
    return this.#identity.authToken.slice();
  }

  async #planeKey(plane: Plane, sessionId: string): Promise<Uint8Array> {
    if (plane === "control") return this.#identity.controlKey;
    if (plane === "meta") return this.#identity.kMeta;
    let key = this.#sessionKeys.get(sessionId);
    if (key === undefined) {
      key = await deriveSessionKey(this.#identity.contentRoot, sessionId);
      this.#sessionKeys.set(sessionId, key);
    }
    return key;
  }

  async sealFrame(plane: Plane, header: FrameHeader, plaintext: Uint8Array): Promise<Frame> {
    return seal(await this.#planeKey(plane, header.sessionId), header, plaintext);
  }

  async openFrame(plane: Plane, frame: Frame): Promise<Uint8Array> {
    return open(await this.#planeKey(plane, frame.sessionId), frame);
  }
}

/**
 * Open (no encryption): the plaintext rides verbatim in `ct`; salt/nonce are zero placeholders so
 * the broker handles every level identically. The relay sees AND can forge everything — this is the
 * trust-the-server mode, never a silent default.
 */
class OpenProvider implements SecurityProvider {
  readonly level = "open" as const;
  readonly #identity: Identity;

  constructor(identity: Identity) {
    this.#identity = identity;
  }

  authBearer(): Uint8Array {
    // Hand back a copy: the bearer is caller-owned and the identity's key must stay immutable.
    return this.#identity.authToken.slice();
  }

  sealFrame(_plane: Plane, header: FrameHeader, plaintext: Uint8Array): Promise<Frame> {
    // Fresh zero salt/nonce per frame (never share a buffer across frames). Copy the plaintext
    // into ct so the returned frame doesn't alias the caller's buffer — Sealed returns a fresh
    // ciphertext buffer too, so the two levels behave identically (caller may reuse `plaintext`).
    return Promise.resolve({
      ...header,
      salt: new Uint8Array(32),
      nonce: new Uint8Array(12),
      ct: plaintext.slice(),
    });
  }

  openFrame(_plane: Plane, frame: Frame): Promise<Uint8Array> {
    // The plaintext rides in ct — nothing to decrypt; copy out so the result doesn't alias the
    // frame buffer (matches Sealed, which returns a fresh plaintext from open()).
    return Promise.resolve(frame.ct.slice());
  }
}

/**
 * Build a provider for the chosen trust level. The caller derives the Identity from its secret or
 * pass and selects the level by config — it MUST NOT default silently to "open".
 */
export function securityProvider(level: Level, identity: Identity): SecurityProvider {
  // Exhaustive switch: adding a Level (e.g. "managed") becomes a compile error here rather than
  // silently falling through to Sealed — the provider must be a deliberate, named choice.
  switch (level) {
    case "open":
      return new OpenProvider(identity);
    case "sealed":
      return new SealedProvider(identity);
    default: {
      const _exhaustive: never = level;
      throw new Error(`unknown security level: ${String(_exhaustive)}`);
    }
  }
}
