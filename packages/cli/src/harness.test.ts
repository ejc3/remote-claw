import { describe, expect, it } from "vitest";
import {
  HARNESSES,
  harnessMetadata,
  harnessPolicy,
  hasClaudeNativeReferences,
  parseHarnessDescriptor,
  parseSessionSettings,
  parseSessionSettingsChange,
  UNKNOWN_HARNESS,
} from "./harness.js";
import { MITM_CAPABILITIES, STABLE_MITM_CAPABILITIES } from "./host/rc/driver.js";

describe("shared harness contract", () => {
  it("accepts exactly one bounded settings selection without permission fields", () => {
    for (const change of [
      { model: "native-model" },
      { effort: "high" },
      { collaborationMode: "plan" },
    ]) {
      expect(parseSessionSettingsChange(change)).toEqual(change);
      expect(parseSessionSettingsChange(change)).not.toBe(change);
    }
    for (const change of [
      null,
      [],
      {},
      { model: "" },
      { model: "x".repeat(257) },
      { model: "model", effort: "high" },
      { permissionMode: "bypassPermissions" },
      { collaborationMode: "plan", developer_instructions: "change policy" },
    ]) {
      expect(parseSessionSettingsChange(change)).toBeNull();
    }
  });

  it("bounds and copies settings catalogs without guessing unknown current settings", () => {
    const snapshot = {
      models: [
        {
          id: "m",
          label: "Native model",
          defaultEffort: "high",
          efforts: [{ id: "high", description: "More reasoning" }],
        },
      ],
      collaborationModes: [{ id: "plan", label: "Plan" }],
      current: { model: "unlisted-native-model", effort: null, collaborationMode: null },
    };
    const parsed = parseSessionSettings(snapshot);
    expect(parsed).toEqual(snapshot);
    expect(parsed?.models[0]).not.toBe(snapshot.models[0]);
    expect(parsed?.models.some((model) => model.id === snapshot.current.model)).toBe(false);
    expect(parseSessionSettings({ ...snapshot, current: {} })).toBeNull();
    expect(
      parseSessionSettings({ ...snapshot, models: [...snapshot.models, ...snapshot.models] }),
    ).toBeNull();
    expect(
      parseSessionSettings({ ...snapshot, collaborationModes: [{ id: "x", label: " " }] }),
    ).toBeNull();
    expect(
      parseSessionSettings({
        ...snapshot,
        models: [{ ...snapshot.models[0], defaultEffort: "missing" }],
      }),
    ).toBeNull();
    expect(
      parseSessionSettings({
        ...snapshot,
        models: Array.from({ length: 33 }, (_, i) => ({ ...snapshot.models[0], id: String(i) })),
      }),
    ).toBeNull();
    expect(
      parseSessionSettings({
        ...snapshot,
        models: Array.from({ length: 32 }, (_, i) => ({
          id: String(i),
          label: "Model",
          defaultEffort: "0",
          efforts: Array.from({ length: 12 }, (_, j) => ({
            id: String(j),
            description: "x".repeat(512),
          })),
        })),
      }),
    ).toBeNull();
  });
  it("reserves pinned Claude native reference grammar without blocking ordinary emails", () => {
    for (const text of [
      '@"/outside/file with spaces.txt"',
      "inspect @/absolute/file",
      "inspect @relative/file",
      "\n@~/private.txt",
      "。@private.txt",
      "、@private.txt",
      "？@private.txt",
      "！@private.txt",
      "@server:resource",
    ])
      expect(hasClaudeNativeReferences(text), text).toBe(true);
    for (const text of [
      "email ej@example.com",
      "name@localhost",
      "read /outside/file",
      "an @ sign",
    ])
      expect(hasClaudeNativeReferences(text), text).toBe(false);
  });
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
