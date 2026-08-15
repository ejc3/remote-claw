import { A1BrokerError } from "./a1-contract";

function invalid(): never {
  throw new A1BrokerError("invalid_request", 400);
}

/** Small strict JSON decoder for the bounded A1 control DTOs. It rejects duplicate members before
 * object construction and preserves the selected-A1 canonical non-negative-integer rule. */
class StrictJsonParser {
  readonly #raw: string;
  #offset = 0;

  constructor(raw: string) {
    this.#raw = raw;
  }

  parse(): unknown {
    this.#space();
    const value = this.#value(0);
    this.#space();
    if (this.#offset !== this.#raw.length) invalid();
    return value;
  }

  #space(): void {
    for (;;) {
      const ch = this.#raw[this.#offset];
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return;
      this.#offset++;
    }
  }

  #value(depth: number): unknown {
    if (depth > 8) invalid();
    const ch = this.#raw[this.#offset];
    if (ch === "{") return this.#object(depth + 1);
    if (ch === "[") return this.#array(depth + 1);
    if (ch === '"') return this.#string();
    if (ch !== undefined && /[0-9]/.test(ch)) return this.#number();
    for (const [token, value] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (this.#raw.startsWith(token, this.#offset)) {
        this.#offset += token.length;
        return value;
      }
    }
    return invalid();
  }

  #object(depth: number): Record<string, unknown> {
    this.#offset++;
    this.#space();
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    if (this.#raw[this.#offset] === "}") {
      this.#offset++;
      return out;
    }
    for (;;) {
      if (this.#raw[this.#offset] !== '"') invalid();
      const key = this.#string();
      if (seen.has(key)) invalid();
      seen.add(key);
      this.#space();
      if (this.#raw[this.#offset] !== ":") invalid();
      this.#offset++;
      this.#space();
      out[key] = this.#value(depth);
      this.#space();
      const next = this.#raw[this.#offset];
      if (next === "}") {
        this.#offset++;
        return out;
      }
      if (next !== ",") invalid();
      this.#offset++;
      this.#space();
      if (this.#raw[this.#offset] === "}") invalid();
    }
  }

  #array(depth: number): unknown[] {
    this.#offset++;
    this.#space();
    const out: unknown[] = [];
    if (this.#raw[this.#offset] === "]") {
      this.#offset++;
      return out;
    }
    for (;;) {
      out.push(this.#value(depth));
      this.#space();
      const next = this.#raw[this.#offset];
      if (next === "]") {
        this.#offset++;
        return out;
      }
      if (next !== ",") invalid();
      this.#offset++;
      this.#space();
      if (this.#raw[this.#offset] === "]") invalid();
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset++;
    for (;;) {
      const ch = this.#raw[this.#offset];
      if (ch === undefined || ch.charCodeAt(0) < 0x20) invalid();
      if (ch === '"') {
        this.#offset++;
        try {
          return JSON.parse(this.#raw.slice(start, this.#offset)) as string;
        } catch {
          return invalid();
        }
      }
      if (ch === "\\") {
        this.#offset++;
        const escaped = this.#raw[this.#offset];
        if (escaped === "u") {
          const hex = this.#raw.slice(this.#offset + 1, this.#offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
          this.#offset += 5;
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) invalid();
      }
      this.#offset++;
    }
  }

  #number(): number {
    const rest = this.#raw.slice(this.#offset);
    const match = /^(?:0|[1-9][0-9]*)/.exec(rest);
    if (match === null) return invalid();
    const token = match[0];
    const next = rest[token.length];
    if (next !== undefined && /[0-9.eE+-]/.test(next)) invalid();
    this.#offset += token.length;
    const value = Number(token);
    if (!Number.isSafeInteger(value)) invalid();
    return value;
  }
}

export function parseStrictControlJson(raw: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return invalid();
  }
  if (text.charCodeAt(0) === 0xfeff) invalid();
  return new StrictJsonParser(text).parse();
}

export function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalid();
  return row;
}

export function requiredString(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

export function requiredSafeUint(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) invalid();
  return value as number;
}

export function requiredLiteral<T extends string | number>(value: unknown, literal: T): T {
  if (value !== literal) invalid();
  return literal;
}

export function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}
