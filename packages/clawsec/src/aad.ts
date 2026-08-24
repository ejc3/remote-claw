// §4.3 / §8 canonical AAD. One serialization binds EVERY cleartext header field, so the
// broker can't shift bytes between fields or swap chunk indices. The encoding is
// length-prefixed and uses a fixed field order, which makes it injective: distinct headers
// always produce distinct bytes (no ad-hoc "a|b|c" ambiguity). The same bytes are used as
// the AES-GCM AAD and folded into the per-message K_msg `info` (§4.3).

import { CanonicalWriter, canonicalByteLength, canonicalByteSnapshot } from "./canonical.js";

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

/**
 * Canonical AAD for a frame header (§4.3/§8). Field order is fixed:
 * v, identity_id, session_id, dir, record_kind, seq, msg_id, client_msg_id?, key_epoch, part, parts.
 *
 * This is a pure injective serializer: it binds whatever values it's given. Semantic chunk
 * constraints (parts ≥ 1, part < parts) are enforced by the chunking layer, not here.
 */
export function canonicalAad(h: FrameHeader): Uint8Array {
  // Snapshot every potentially accessor-backed field once before validation.
  const {
    v,
    identityId,
    sessionId,
    dir,
    recordKind,
    seq,
    msgId,
    clientMsgId,
    keyEpoch,
    part,
    parts,
  } = h;
  const identityIdSnapshot = canonicalByteSnapshot(identityId);
  const identityIdLength = canonicalByteLength(identityIdSnapshot);
  if (identityIdLength !== 16) {
    throw new RangeError(`identityId must be 16 bytes, got ${identityIdLength}`);
  }
  if (dir !== "in" && dir !== "out") {
    throw new RangeError('dir must be "in" or "out"');
  }
  const w = new CanonicalWriter();
  w.uint(v);
  w.bytes(identityIdSnapshot);
  w.str(sessionId);
  w.str(dir);
  w.str(recordKind);
  w.optionalUint(seq);
  w.str(msgId);
  // Canonical encoding uses explicit null for an absent optional string. Adapt the DTO's omitted
  // property at this boundary while rejecting explicit null or non-string runtime values.
  if (clientMsgId !== undefined && typeof clientMsgId !== "string") {
    throw new TypeError("clientMsgId must be a string when present");
  }
  w.optionalStr(clientMsgId === undefined ? null : clientMsgId);
  w.uint(keyEpoch);
  w.uint(part);
  w.uint(parts);
  return w.finish();
}
