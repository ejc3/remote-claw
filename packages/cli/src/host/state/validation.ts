import { HostStateContractError } from "./ids.js";

export type UnknownRecord = Record<string, unknown>;
const MAX_CONTRACT_STRING_CODE_UNITS = 1024;

export function reject(field: string, requirement: string): never {
  throw new HostStateContractError(`${field} ${requirement}`);
}

export function parseExactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): UnknownRecord {
  if (typeof value !== "object" || value === null) {
    reject(field, "must be an object");
  }
  let isArray: boolean;
  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    reject(field, "could not be inspected safely");
  }
  if (isArray) {
    reject(field, "must be an object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    reject(field, "must be a plain object");
  }
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    reject(field, "must contain exactly the selected fields");
  }
  const snapshot = Object.create(null) as UnknownRecord;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      reject(field, "could not be inspected safely");
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      reject(field, "must contain only own data properties");
    }
    snapshot[key] = descriptor.value as unknown;
  }
  return snapshot;
}

export function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    reject(field, "must be a non-empty string");
  }
  if (value.length > MAX_CONTRACT_STRING_CODE_UNITS) {
    reject(field, `must be at most ${MAX_CONTRACT_STRING_CODE_UNITS} UTF-16 code units`);
  }
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        reject(field, "must contain only Unicode scalar values");
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      reject(field, "must contain only Unicode scalar values");
    }
  }
  return value;
}

export function parseLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) reject(field, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

export function parseEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    reject(field, "is not a selected value");
  }
  return value as T[number];
}

export function parseNonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    reject(field, "must be a non-negative safe integer");
  }
  return value as number;
}

export function parsePositiveSafeInteger(value: unknown, field: string): number {
  const parsed = parseNonNegativeSafeInteger(value, field);
  if (parsed === 0) reject(field, "must be greater than zero");
  return parsed;
}

export function parseNullable<T>(
  value: unknown,
  parser: (input: unknown, field: string) => T,
  field: string,
): T | null {
  return value === null ? null : parser(value, field);
}

export function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
