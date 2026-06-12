// §8 wire envelope. A Frame (in-memory: Uint8Array byte fields) ⇄ a JSON-safe object that crosses
// the HTTP/SSE boundary to the broker and back. The broker stores/forwards this verbatim and never
// decrypts it; only the cleartext routing header (identity_id, session_id, dir, record_kind, seq,
// msg_id, key_epoch, part, parts) is meaningful to it.
//
// identity_id is rendered as 32-char lowercase HEX — the one canonical public identity form used
// everywhere else (identityHex / busToken / sessionToken / the CLI's --rc-identity|--rc-pass
// output), so a wire frame's identity_id matches the derived channel token byte-for-byte; the three
// opaque binary blobs (salt, nonce, ct) ride as the more compact base64url.
//
// decodeFrame is STRICT: every field is validated for type and bounded length, because this is the
// trust boundary where attacker-controlled JSON enters (a bad identity_id length, oversized routing
// string, or a non-12-byte nonce must fail here, not deep inside AES-GCM).

import type { Dir, FrameHeader } from "./aad.js";
import type { Frame } from "./aead.js";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { fromHex, toHex } from "./bytes.js";

/** The JSON-safe wire form of a Frame (snake_case per §8); byte fields are base64url strings. */
export interface WireFrame {
  v: number;
  identity_id: string;
  session_id: string;
  dir: Dir;
  record_kind: string;
  seq: number | null;
  msg_id: string;
  client_msg_id?: string;
  key_epoch: number;
  salt: string;
  nonce: string;
  ct: string;
  part: number;
  parts: number;
}

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
  static is(e: unknown): e is WireError {
    return e instanceof WireError;
  }
}

const MAX_ROUTING_STRING = 256;
const MAX_MSG_ID = 1024;

/** Serialize a Frame to its JSON-safe wire form. */
export function encodeFrame(frame: Frame): WireFrame {
  const wire: WireFrame = {
    v: frame.v,
    identity_id: toHex(frame.identityId),
    session_id: frame.sessionId,
    dir: frame.dir,
    record_kind: frame.recordKind,
    seq: frame.seq,
    msg_id: frame.msgId,
    key_epoch: frame.keyEpoch,
    salt: base64urlEncode(frame.salt),
    nonce: base64urlEncode(frame.nonce),
    ct: base64urlEncode(frame.ct),
    part: frame.part,
    parts: frame.parts,
  };
  // exactOptionalPropertyTypes: only attach client_msg_id when actually present.
  if (frame.clientMsgId !== undefined) wire.client_msg_id = frame.clientMsgId;
  return wire;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WireError("frame must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new WireError(`${key} must be a string`);
  return v;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function reqBoundedString(
  o: Record<string, unknown>,
  key: string,
  max: number,
  opts: { noControlChars?: boolean } = {},
): string {
  const s = reqString(o, key);
  if (s.length > max) throw new WireError(`${key} must be at most ${max} characters`);
  if (opts.noControlChars && hasControlChar(s)) {
    throw new WireError(`${key} must not contain ASCII control characters`);
  }
  return s;
}

/**
 * The integer domain every numeric header field shares — non-negative and ≤ MAX_SAFE_INTEGER, the
 * exact range the AAD writer's uint() accepts (aad.ts). Checked here, at the boundary, so an
 * out-of-range value is a clean WireError instead of a RangeError thrown later inside canonicalAad.
 */
function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

function reqUint(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (!isNonNegSafeInt(v)) throw new WireError(`${key} must be a non-negative safe integer`);
  return v;
}

function reqBytes(o: Record<string, unknown>, key: string, len?: number): Uint8Array {
  const s = reqString(o, key);
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(s);
  } catch {
    throw new WireError(`${key} is not valid base64url`);
  }
  if (len !== undefined && bytes.length !== len) {
    throw new WireError(`${key} must decode to ${len} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Parse a hex-encoded byte field (identity_id) to exactly `len` bytes — the canonical id form. */
function reqHexBytes(o: Record<string, unknown>, key: string, len: number): Uint8Array {
  const s = reqString(o, key);
  let bytes: Uint8Array;
  try {
    bytes = fromHex(s);
  } catch {
    throw new WireError(`${key} is not valid hex`);
  }
  if (bytes.length !== len) {
    throw new WireError(`${key} must decode to ${len} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Parse + validate a wire object into a Frame. Throws WireError on any malformed field. This is
 * the broker→client / client→broker trust boundary, so it is deliberately exhaustive: lengths of
 * identity_id (16), salt (32) and nonce (12) are checked here so a bad frame is rejected before it
 * reaches the AEAD layer; dir is constrained to "in"/"out"; seq is `number|null`.
 */
export function decodeFrame(value: unknown): Frame {
  const o = asObject(value);

  const dir = reqString(o, "dir");
  if (dir !== "in" && dir !== "out") throw new WireError(`dir must be "in" or "out", got ${dir}`);

  // seq shares the same non-negative-safe-int domain as the other uints, OR is null (control/meta
  // frames). Enforcing the upper bound HERE keeps an out-of-range seq from reaching canonicalAad's
  // optionalUint() and throwing a RangeError past the boundary.
  const seqRaw = o.seq;
  let seq: number | null;
  if (seqRaw === null) {
    seq = null;
  } else if (isNonNegSafeInt(seqRaw)) {
    seq = seqRaw;
  } else {
    throw new WireError("seq must be a non-negative safe integer or null");
  }

  const header: FrameHeader = {
    v: reqUint(o, "v"),
    identityId: reqHexBytes(o, "identity_id", 16),
    sessionId: reqBoundedString(o, "session_id", MAX_ROUTING_STRING, { noControlChars: true }),
    dir,
    recordKind: reqBoundedString(o, "record_kind", MAX_ROUTING_STRING, { noControlChars: true }),
    seq,
    msgId: reqBoundedString(o, "msg_id", MAX_MSG_ID),
    keyEpoch: reqUint(o, "key_epoch"),
    part: reqUint(o, "part"),
    parts: reqUint(o, "parts"),
  };

  // exactOptionalPropertyTypes: client_msg_id is set only when present (string) — reject other
  // non-undefined types so a `{client_msg_id: 5}` can't slip through unchecked.
  if (o.client_msg_id !== undefined) {
    header.clientMsgId = reqBoundedString(o, "client_msg_id", MAX_ROUTING_STRING);
  }

  return {
    ...header,
    salt: reqBytes(o, "salt", 32),
    nonce: reqBytes(o, "nonce", 12),
    ct: reqBytes(o, "ct"),
  };
}
