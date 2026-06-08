// §4.3 / §8 canonical AAD. One serialization binds EVERY cleartext header field, so the
// broker can't shift bytes between fields or swap chunk indices. The encoding is
// length-prefixed and uses a fixed field order, which makes it injective: distinct headers
// always produce distinct bytes (no ad-hoc "a|b|c" ambiguity). The same bytes are used as
// the AES-GCM AAD and folded into the per-message K_msg `info` (§4.3).

import { concatBytes, utf8 } from "./bytes.js";

export type Dir = "in" | "out";

export interface FrameHeader {
  /** Protocol version. */
  v: number;
  /** 16-byte identity id. */
  identityId: Uint8Array;
  sessionId: string;
  dir: Dir;
  recordKind: string;
  /** Transcript order; null for frames that don't carry one (e.g. control/meta). */
  seq: number | null;
  msgId: string;
  /** Present only on a `user` prompt. */
  clientMsgId?: string;
  /** Key-rotation epoch. */
  keyEpoch: number;
  /** Chunk index (0-based); non-chunked frames use part=0, parts=1. */
  part: number;
  parts: number;
}

const U32_MAX = 0xffffffff;

class Writer {
  private chunks: Uint8Array[] = [];

  private push(b: Uint8Array): void {
    this.chunks.push(b);
  }

  /** Length-prefixed bytes: [u32 BE length][bytes]. */
  bytes(b: Uint8Array): void {
    if (b.length > U32_MAX) throw new RangeError("field too large");
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, b.length, false);
    this.push(prefix);
    this.push(b);
  }

  str(s: string): void {
    this.bytes(utf8(s));
  }

  /** A non-negative safe integer as a length-prefixed u64 BE (uniform with bytes()). */
  uint(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`expected a non-negative safe integer, got ${n}`);
    }
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
    this.bytes(b);
  }

  /** Presence byte (0=absent) then the value, so null/undefined is distinct from any value. */
  optionalUint(n: number | null): void {
    if (n === null) {
      this.push(Uint8Array.of(0));
      return;
    }
    this.push(Uint8Array.of(1));
    this.uint(n);
  }

  optionalStr(s: string | undefined): void {
    if (s === undefined) {
      this.push(Uint8Array.of(0));
      return;
    }
    this.push(Uint8Array.of(1));
    this.str(s);
  }

  concat(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

/**
 * Canonical AAD for a frame header (§4.3/§8). Field order is fixed:
 * v, identity_id, session_id, dir, record_kind, seq, msg_id, client_msg_id?, key_epoch, part, parts.
 *
 * This is a pure injective serializer: it binds whatever values it's given. Semantic chunk
 * constraints (parts ≥ 1, part < parts) are enforced by the chunking layer, not here.
 */
export function canonicalAad(h: FrameHeader): Uint8Array {
  if (h.identityId.length !== 16) {
    throw new RangeError(`identityId must be 16 bytes, got ${h.identityId.length}`);
  }
  if (h.dir !== "in" && h.dir !== "out") {
    throw new RangeError(`dir must be "in" or "out", got ${h.dir}`);
  }
  const w = new Writer();
  w.uint(h.v);
  w.bytes(h.identityId);
  w.str(h.sessionId);
  w.str(h.dir);
  w.str(h.recordKind);
  w.optionalUint(h.seq);
  w.str(h.msgId);
  w.optionalStr(h.clientMsgId);
  w.uint(h.keyEpoch);
  w.uint(h.part);
  w.uint(h.parts);
  return w.concat();
}
