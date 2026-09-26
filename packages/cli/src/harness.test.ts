import { describe, expect, it } from "vitest";
import {
  HARNESSES,
  harnessMetadata,
  harnessPolicy,
  hasClaudeNativeReferences,
  parseHarnessDescriptor,
  parseNativeFileInput,
  parseNativePatchInput,
  UNKNOWN_HARNESS,
} from "./harness.js";
import { MITM_CAPABILITIES, STABLE_MITM_CAPABILITIES } from "./host/rc/driver.js";

describe("shared harness contract", () => {
  it("copies bounded native patches without losing paths or diff tails", () => {
    const input = { changes: [{ path: "/tmp/a", operation: "update", diff: "-before\n+after" }] };
    const parsed = parseNativePatchInput(input);
    const first = input.changes[0];
    if (first) first.diff = "changed";
    expect(parsed?.changes[0]?.diff).toBe("-before\n+after");
    expect(
      parseNativePatchInput({ changes: [{ path: "C:\\work\\empty", operation: "add", diff: "" }] }),
    ).not.toBeNull();
  });

  it("rejects ambiguous, oversized, or incomplete patch projections", () => {
    const change = { path: "/tmp/a", operation: "update", diff: "-a\n+b" };
    for (const input of [
      { changes: [] },
      { changes: [change], grantRoot: "/" },
      { changes: [change, change] },
      { changes: [{ ...change, path: "relative" }] },
      { changes: [{ ...change, path: "/tmp/hidden\u202Etxt" }] },
      { changes: [{ ...change, operation: "move" }] },
      { changes: [{ ...change, move_path: "/tmp/b" }] },
      { changes: [{ ...change, diff: "" }] },
      { changes: [{ ...change, diff: "🔥".repeat(8192) }] },
      { changes: Array.from({ length: 21 }, (_, i) => ({ ...change, path: `/tmp/${i}` })) },
    ])
      expect(parseNativePatchInput(input)).toBeNull();
  });

  it("copies only exact captured native file inputs", () => {
    const input = { file_path: "/tmp/scratch.txt", content: "" };
    const parsed = parseNativeFileInput("Write", input);
    input.content = "later rewrite";
    expect(parsed).toEqual({
      tool: "Write",
      input: { file_path: "/tmp/scratch.txt", content: "" },
    });
    expect(parseNativeFileInput("Read", { file_path: "/tmp/scratch.txt" })?.tool).toBe("Read");
    expect(
      parseNativeFileInput("Edit", {
        file_path: "/tmp/scratch.txt",
        old_string: " ",
        new_string: "",
        replace_all: false,
      })?.tool,
    ).toBe("Edit");
  });

  it("keeps unsupported file shapes and oversized UTF-8 details native-owned", () => {
    for (const [tool, input] of [
      ["Read", { file_path: "/tmp/file", offset: 1 }],
      ["Write", { file_path: "/tmp/file", content: "ok", updatedPermissions: [] }],
      ["Write", { file_path: "/tmp/file", content: "🔥".repeat(8192) }],
      ["Write", { file_path: " ", content: "ok" }],
      ["Read", { file_path: "/tmp/hidden\nfile" }],
      ["Read", { file_path: "/tmp/hidden\u202Etxt" }],
      ["Edit", { file_path: "/tmp/file", old_string: "a", new_string: "b", replace_all: true }],
      ["Edit", { file_path: "/tmp/file", old_string: "", new_string: "b", replace_all: false }],
      ["Other", { file_path: "/tmp/file" }],
    ])
      expect(parseNativeFileInput(tool, input)).toBeNull();
    expect(
      parseNativeFileInput("Write", { file_path: "/tmp/file", content: "a".repeat(32000) })?.tool,
    ).toBe("Write");
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
