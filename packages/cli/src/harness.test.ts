import { describe, expect, it } from "vitest";
import {
  HARNESSES,
  harnessMetadata,
  harnessPolicy,
  parseHarnessDescriptor,
  UNKNOWN_HARNESS,
} from "./harness.js";
import { MITM_CAPABILITIES, STABLE_MITM_CAPABILITIES } from "./host/rc/driver.js";

describe("shared harness contract", () => {
  it.each(
    Object.values(HARNESSES),
  )("recognizes $label / $detail without importing native code", (metadata) => {
    expect(harnessMetadata(parseHarnessDescriptor(metadata.descriptor))).toBe(metadata);
  });

  it.each([
    "claude-native",
    "opencode",
    "codex",
  ] as const)("keeps %s native semantics independent of feature flags", (name) => {
    const descriptor = HARNESSES[name].descriptor;
    const expected = {
      ordering: "native",
      requireDurable: HARNESSES[name].requireDurable,
      textInput: "plain",
    };
    expect(harnessPolicy(descriptor, undefined)).toEqual(expected);
    expect(harnessPolicy(descriptor, STABLE_MITM_CAPABILITIES)).toEqual(expected);
    expect(harnessPolicy(descriptor, { ...MITM_CAPABILITIES, textInput: "plain" })).toEqual(
      expected,
    );
  });

  it("keeps stable MITM input/durability explicit while preserving legacy experimental MITM", () => {
    const descriptor = HARNESSES.mitm.descriptor;
    expect(harnessPolicy(descriptor, { ...MITM_CAPABILITIES, textInput: "plain" })).toEqual({
      ordering: "relay",
      requireDurable: true,
      textInput: "plain",
    });
    expect(harnessPolicy(descriptor, MITM_CAPABILITIES)).toEqual({
      ordering: "relay",
      requireDurable: false,
      textInput: "legacy",
    });
    const { textInput: _oldHost, ...legacyStable } = STABLE_MITM_CAPABILITIES;
    expect(harnessPolicy(descriptor, legacyStable).textInput).toBe("plain");
  });

  it("does not weaken terminal input or accept unknown input semantics", () => {
    expect(
      harnessPolicy(HARNESSES.tmux.descriptor, { ...MITM_CAPABILITIES, textInput: "plain" })
        .textInput,
    ).toBe("terminal");
    expect(
      harnessPolicy(HARNESSES.codex.descriptor, {
        ...MITM_CAPABILITIES,
        textInput: "future-policy",
      }).textInput,
    ).toBe("blocked");
  });

  it.each([
    null,
    "codex",
    {},
    { agent: "grok", mode: "rc" },
    { agent: "codex", mode: "rc" },
  ])("fails an explicit unknown descriptor closed: %j", (raw) => {
    const descriptor = parseHarnessDescriptor(raw);
    expect(descriptor).toEqual(UNKNOWN_HARNESS);
    expect(harnessPolicy(descriptor, MITM_CAPABILITIES).textInput).toBe("blocked");
    expect(harnessMetadata(descriptor).label).toBe("Unknown agent");
  });

  it("retains only the absent descriptor as legacy MITM", () => {
    expect(parseHarnessDescriptor(undefined)).toBeUndefined();
    expect(harnessMetadata(undefined)).toBe(HARNESSES.mitm);
  });
});
