import { describe, expect, it } from "vitest";
import { HostStateContractError } from "./ids.js";
import {
  parseExactRecord,
  parseNonEmptyString,
  parseNonNegativeSafeInteger,
} from "./validation.js";

describe("exact host-state records", () => {
  it("rejects negative zero instead of aliasing canonical zero", () => {
    expect(() => parseNonNegativeSafeInteger(-0, "fixture")).toThrow(/non-negative safe integer/);
    expect(parseNonNegativeSafeInteger(0, "fixture")).toBe(0);
  });

  it("snapshots own data properties without retaining the caller's record", () => {
    const value = { first: "one", second: 2 };
    const parsed = parseExactRecord(value, ["first", "second"], "fixture");
    value.first = "changed";

    expect(parsed.first).toBe("one");
    expect(parsed.second).toBe(2);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it("rejects accessor properties without invoking them", () => {
    let invoked = false;
    const value = {};
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        return "must-not-be-read";
      },
    });

    expect(() => parseExactRecord(value, ["secret"], "fixture")).toThrow(
      /only own data properties/,
    );
    expect(invoked).toBe(false);
  });

  it("rejects unexpected keys before requesting their property descriptors", () => {
    let descriptorReads = 0;
    const value = new Proxy(
      {},
      {
        ownKeys() {
          return ["selected", "unexpected"];
        },
        getOwnPropertyDescriptor() {
          descriptorReads++;
          return { configurable: true, enumerable: true, value: "value" };
        },
      },
    );

    expect(() => parseExactRecord(value, ["selected"], "fixture")).toThrow(
      /exactly the selected fields/,
    );
    expect(descriptorReads).toBe(0);
  });

  it("rejects symbol keys instead of hiding them from exact-record validation", () => {
    const hidden = Symbol("hidden");
    expect(() => parseExactRecord({ selected: 1, [hidden]: 2 }, ["selected"], "fixture")).toThrow(
      /exactly the selected fields/,
    );
  });

  it("redacts errors thrown while inspecting a hostile record", () => {
    const secret = "inspection-secret-must-not-escape";
    const value = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(secret);
        },
      },
    );

    let error: unknown;
    try {
      parseExactRecord(value, [], "fixture");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HostStateContractError);
    expect(String(error)).toContain("fixture could not be inspected safely");
    expect(String(error)).not.toContain(secret);
  });

  it("redacts a revoked proxy failure before record inspection", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    let error: unknown;
    try {
      parseExactRecord(proxy, [], "fixture");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HostStateContractError);
    expect(String(error)).toContain("fixture could not be inspected safely");
    expect(String(error)).not.toContain("revoked");
  });

  it("bounds contract strings and accepts only Unicode scalar values", () => {
    expect(parseNonEmptyString("schema-😀", "fixture")).toBe("schema-😀");
    expect(() => parseNonEmptyString("\0schema", "fixture")).toThrow(/U\+0000/);
    expect(() => parseNonEmptyString("x".repeat(1025), "fixture")).toThrow(
      /at most 1024 UTF-16 code units/,
    );
    for (const value of ["\ud800", "\udc00", `a\ud800b`]) {
      expect(() => parseNonEmptyString(value, "fixture")).toThrow(/Unicode scalar values/);
    }
  });
});
