// Cross-runtime canonical field encoding shared by A0 AAD and A1 signed/wire records.
// Keep this module limited to Web Platform primitives so the exact same implementation runs
// in Node and browsers.

import { concatBytes, utf8 } from "./bytes.js";

const U32_MAX = 0xffffffff;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "length")
  ?.get as (this: Uint8Array) => number;
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get as (this: Uint8Array) => string | undefined;

function assertFieldLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`invalid field length: ${length}`);
  }
  if (length > U32_MAX) {
    throw new RangeError("field too large");
  }
}

/** Return the intrinsic byte length of a genuine Uint8Array, ignoring subclass overrides. */
export function canonicalByteLength(value: Uint8Array): number {
  if (
    !ArrayBuffer.isView(value) ||
    Reflect.apply(TYPED_ARRAY_TAG_GETTER, value, []) !== "Uint8Array"
  ) {
    throw new TypeError("expected Uint8Array");
  }
  const length = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []) as number;
  assertFieldLength(length);
  return length;
}

/**
 * Copy a genuine Uint8Array into a fixed-length, caller-independent snapshot.
 *
 * A length-tracking view over a growable SharedArrayBuffer can grow between
 * operations. The copied snapshot, rather than an earlier source length, is
 * therefore the value that every later validation and encoding must describe.
 */
export function canonicalByteSnapshot(value: Uint8Array): Uint8Array<ArrayBuffer> {
  canonicalByteLength(value);
  const snapshot = new Uint8Array(value);
  canonicalByteLength(snapshot);
  return snapshot;
}

function encodedBytes(value: Uint8Array): readonly [Uint8Array, Uint8Array] {
  const snapshot = canonicalByteSnapshot(value);
  const length = canonicalByteLength(snapshot);
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, length, false);
  return [prefix, snapshot];
}

function encodedUint(value: number): readonly [Uint8Array, Uint8Array] {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    Object.is(value, -0) ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError("expected a non-negative safe integer");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return encodedBytes(bytes);
}

function assertUnicodeScalars(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        throw new TypeError("expected a string of Unicode scalar values");
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("expected a string of Unicode scalar values");
    }
  }
}

/**
 * The canonical length-prefixed field writer selected by the protocol (§4.3).
 *
 * Optional fields use explicit `null` as the absent value. `finish()` seals the writer and
 * returns a defensive snapshot; mutating that returned `Uint8Array` cannot affect the writer
 * or a later snapshot.
 */
export class CanonicalWriter {
  private readonly chunks: Uint8Array[] = [];
  private finishedBytes: Uint8Array | null = null;
  private destroyed = false;

  private assertOpen(): void {
    if (this.destroyed) {
      throw new Error("canonical writer was destroyed");
    }
    if (this.finishedBytes !== null) {
      throw new Error("canonical writer is already finished");
    }
  }

  /** Length-prefixed bytes: `[u32 BE byte length][bytes]`. */
  bytes(value: Uint8Array): void {
    this.assertOpen();
    this.chunks.push(...encodedBytes(value));
  }

  /** A UTF-8 string encoded with {@link bytes}. No Unicode normalization is performed. */
  str(value: string): void {
    this.assertOpen();
    if (typeof value !== "string") {
      throw new TypeError("expected string");
    }
    assertUnicodeScalars(value);
    this.chunks.push(...encodedBytes(utf8(value)));
  }

  /** A non-negative safe integer as length-prefixed u64 BE. */
  uint(value: number): void {
    this.assertOpen();
    this.chunks.push(...encodedUint(value));
  }

  /** Presence byte (`0` absent, `1` present), followed by {@link uint} when present. */
  optionalUint(value: number | null): void {
    this.assertOpen();
    if (value === null) {
      this.chunks.push(Uint8Array.of(0));
      return;
    }
    const encoded = encodedUint(value);
    this.chunks.push(Uint8Array.of(1), ...encoded);
  }

  /** Presence byte (`0` absent, `1` present), followed by {@link str} when present. */
  optionalStr(value: string | null): void {
    this.assertOpen();
    if (value === null) {
      this.chunks.push(Uint8Array.of(0));
      return;
    }
    if (typeof value !== "string") {
      throw new TypeError("expected string or null");
    }
    assertUnicodeScalars(value);
    const encoded = encodedBytes(utf8(value));
    this.chunks.push(Uint8Array.of(1), ...encoded);
  }

  /** Presence byte (`0` absent, `1` present), followed by {@link bytes} when present. */
  optionalBytes(value: Uint8Array | null): void {
    this.assertOpen();
    if (value === null) {
      this.chunks.push(Uint8Array.of(0));
      return;
    }
    const encoded = encodedBytes(value);
    this.chunks.push(Uint8Array.of(1), ...encoded);
  }

  /**
   * Seal this writer and return its canonical bytes.
   *
   * Every call returns a fresh defensive copy. Field methods reject writes after the first call.
   */
  finish(): Uint8Array {
    if (this.destroyed) {
      throw new Error("canonical writer was destroyed");
    }
    if (this.finishedBytes === null) {
      this.finishedBytes = concatBytes(...this.chunks);
      for (const chunk of this.chunks) chunk.fill(0);
      this.chunks.length = 0;
    }
    return this.finishedBytes.slice();
  }

  /** Erase retained field/preimage copies. The writer cannot be reused after destruction. */
  destroy(): void {
    if (this.destroyed) return;
    for (const chunk of this.chunks) chunk.fill(0);
    this.chunks.length = 0;
    this.finishedBytes?.fill(0);
    this.finishedBytes = null;
    this.destroyed = true;
  }
}
