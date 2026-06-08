// §8 chunking. A plaintext larger than a transport limit (hook ≤4.5 MB, stream ≤10 MB) is
// split into `parts` chunks that share one msg_id; each chunk is an INDEPENDENT AEAD frame
// with its own salt/nonce and its (part, parts) bound into the AAD (§4.3). The receiver
// decrypts each chunk (AEAD-verifying part/parts/msg_id and the rest of the header), then
// reassembles in part order once all parts are present — so a forged/replayed/reordered chunk
// fails AEAD before it can corrupt the buffer.

import type { FrameHeader } from "./aad.js";
import { type Frame, open, seal } from "./aead.js";
import { concatBytes, toHex } from "./bytes.js";

/** A chunk frame's header is the frame header minus part/parts, which chunking assigns. */
export type ChunkHeader = Omit<FrameHeader, "part" | "parts">;

// A generous ceiling on chunk count: at the ~8 MB chunk target this is far beyond any real
// message, and it fails a hostile/absurd `parts` fast (clear ChunkError, not OOM/RangeError).
const MAX_PARTS = 100_000;

export class ChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkError";
  }
  static is(e: unknown): e is ChunkError {
    return e instanceof ChunkError;
  }
}

/** Split a plaintext into ≤ maxChunkBytes pieces. Empty plaintext yields a single empty piece. */
export function splitPlaintext(plaintext: Uint8Array, maxChunkBytes: number): Uint8Array[] {
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new ChunkError("maxChunkBytes must be a positive integer");
  }
  if (plaintext.length === 0) return [new Uint8Array(0)];
  const pieces: Uint8Array[] = [];
  // slice() (a copy, not a subarray view) so a caller mutating `plaintext` afterward can't
  // alter the returned pieces.
  for (let off = 0; off < plaintext.length; off += maxChunkBytes) {
    pieces.push(plaintext.slice(off, Math.min(off + maxChunkBytes, plaintext.length)));
  }
  return pieces;
}

/** Seal a plaintext as one or more chunk frames (all sharing header.msgId). */
export async function sealChunked(
  planeKey: Uint8Array,
  header: ChunkHeader,
  plaintext: Uint8Array,
  maxChunkBytes: number,
): Promise<Frame[]> {
  const pieces = splitPlaintext(plaintext, maxChunkBytes);
  const parts = pieces.length;
  if (parts > MAX_PARTS) {
    throw new ChunkError(`too many chunks (${parts} > ${MAX_PARTS}); use a larger maxChunkBytes`);
  }
  const frames: Frame[] = [];
  for (let part = 0; part < parts; part++) {
    frames.push(await seal(planeKey, { ...header, part, parts }, pieces[part] as Uint8Array));
  }
  return frames;
}

/** True iff two frames carry the same message header (everything except part/salt/nonce/ct). */
function sameMessage(a: Frame, b: Frame): boolean {
  return (
    a.v === b.v &&
    a.sessionId === b.sessionId &&
    a.dir === b.dir &&
    a.recordKind === b.recordKind &&
    a.seq === b.seq &&
    a.msgId === b.msgId &&
    a.clientMsgId === b.clientMsgId &&
    a.keyEpoch === b.keyEpoch &&
    toHex(a.identityId) === toHex(b.identityId)
  );
}

/**
 * Reassemble chunk frames into the original plaintext. Requires exactly `parts` frames, all
 * from the same message (same msg_id and header), covering parts 0..parts-1 with no gaps or
 * duplicates. Each chunk is AEAD-verified; any forged/tampered chunk throws.
 *
 * Relies on the sender's invariant that `msg_id` is CSPRNG-unique per message (§6/§8): chunks
 * only group when their full headers match, so distinct messages (distinct msg_id) can't be
 * mixed — but a sender that reused a msg_id across two messages with identical headers could.
 */
export async function openChunked(planeKey: Uint8Array, frames: Frame[]): Promise<Uint8Array> {
  if (frames.length === 0) throw new ChunkError("no frames to reassemble");
  const first = frames[0] as Frame;
  const parts = first.parts;
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) {
    throw new ChunkError(`invalid parts: ${parts}`);
  }
  if (frames.length !== parts) {
    throw new ChunkError(`expected ${parts} frames, got ${frames.length}`);
  }

  const slots: (Uint8Array | undefined)[] = new Array(parts);
  for (const f of frames) {
    if (f.parts !== parts) throw new ChunkError("inconsistent parts across frames");
    if (!sameMessage(first, f)) throw new ChunkError("frames are not from the same message");
    if (!Number.isInteger(f.part) || f.part < 0 || f.part >= parts) {
      throw new ChunkError(`part out of range: ${f.part}`);
    }
    if (slots[f.part] !== undefined) throw new ChunkError(`duplicate part ${f.part}`);
    // open() AEAD-verifies the chunk's own (part, parts, msg_id, …) via its AAD.
    slots[f.part] = await open(planeKey, f);
  }
  // length === parts, no duplicates, every part in [0, parts) ⇒ all slots are filled. Assert it
  // explicitly so a future logic change can't silently drop a chunk (concatBytes would skip an
  // undefined slot, corrupting the message).
  const complete: Uint8Array[] = [];
  for (let i = 0; i < parts; i++) {
    const slot = slots[i];
    if (slot === undefined) throw new ChunkError(`missing part ${i}`);
    complete.push(slot);
  }
  return concatBytes(...complete);
}
