import { describe, expect, it } from "vitest";
import {
  basename,
  diffOf,
  dirname,
  editStat,
  isSlashCommand,
  parseTask,
  parseToolResult,
  parseToolUse,
  sanitizeInput,
  toolHint,
} from "../app/lib/transcript.js";

describe("isSlashCommand", () => {
  it("recognizes a bare command and a command with args", () => {
    for (const t of ["/compact", "/clear", "/context", "/model opus", "  /compact  "]) {
      expect(isSlashCommand(t)).toBe(true);
    }
  });

  it("does NOT treat a path or a normal message as a command", () => {
    for (const t of [
      "/home/ubuntu/file",
      "/",
      "hello",
      "use /compact later",
      "//double",
      "/ space",
    ]) {
      expect(isSlashCommand(t)).toBe(false);
    }
  });
});

describe("parseToolUse", () => {
  it("parses a well-formed tool_use frame", () => {
    const r = parseToolUse(JSON.stringify({ name: "Bash", input: { command: "ls" }, sub: true }));
    expect(r).toEqual({ name: "Bash", input: { command: "ls" }, sub: true });
  });

  it("falls back on malformed JSON instead of throwing", () => {
    expect(parseToolUse("not json")).toEqual({ name: "tool", input: {}, sub: false });
  });

  it("defaults a missing/non-string name to 'tool'", () => {
    expect(parseToolUse(JSON.stringify({ name: 42 })).name).toBe("tool");
    expect(parseToolUse(JSON.stringify({ input: { command: "x" } })).name).toBe("tool");
  });
});

describe("sanitizeInput", () => {
  it("keeps only string-typed known fields", () => {
    // A numeric file_path must be dropped so basename()/split() never see a non-string (codex #1).
    const out = sanitizeInput({ file_path: 7, command: "ls", description: "list", junk: { a: 1 } });
    expect(out).toEqual({ command: "ls", description: "list" });
    expect("file_path" in out).toBe(false);
  });

  it("returns {} for non-object input", () => {
    expect(sanitizeInput(null)).toEqual({});
    expect(sanitizeInput("nope")).toEqual({});
    expect(sanitizeInput(undefined)).toEqual({});
  });

  it("normalizes a MultiEdit edits[] keeping only string members", () => {
    const out = sanitizeInput({
      file_path: "a.ts",
      edits: [{ old_string: "x", new_string: "y" }, { old_string: 1, new_string: "z" }, "garbage"],
    });
    expect(out.edits).toEqual([{ old_string: "x", new_string: "y" }, { new_string: "z" }, {}]);
  });
});

describe("diffOf", () => {
  it("strips common leading/trailing lines, keeping only the changed region", () => {
    // a\nb\nc → a\nB\nc must be +1/−1 on line b, not +3/−3 (codex #3).
    const { rem, add } = diffOf({ old_string: "a\nb\nc", new_string: "a\nB\nc" });
    expect(rem).toEqual(["b"]);
    expect(add).toEqual(["B"]);
  });

  it("treats a Write (content only) as all-added", () => {
    const { rem, add } = diffOf({ content: "line1\nline2" });
    expect(rem).toEqual([]);
    expect(add).toEqual(["line1", "line2"]);
  });

  it("renders a MultiEdit by concatenating each hunk's changes", () => {
    const { rem, add } = diffOf({
      edits: [
        { old_string: "foo", new_string: "bar" },
        { old_string: "keep\nold\nkeep", new_string: "keep\nnew\nkeep" },
      ],
    });
    expect(rem).toEqual(["foo", "old"]);
    expect(add).toEqual(["bar", "new"]);
  });

  it("is empty when old and new are identical", () => {
    expect(diffOf({ old_string: "same", new_string: "same" })).toEqual({ rem: [], add: [] });
  });
});

describe("editStat", () => {
  it("counts only the changed lines, matching the diff", () => {
    expect(editStat({ old_string: "a\nb\nc", new_string: "a\nB\nc" })).toEqual({ add: 1, del: 1 });
  });

  it("counts a Write as added-only", () => {
    expect(editStat({ content: "x\ny\nz" })).toEqual({ add: 3, del: 0 });
  });
});

describe("parseToolResult", () => {
  it("parses tool_use_id, is_error, output, sub", () => {
    expect(
      parseToolResult(
        JSON.stringify({ tool_use_id: "toolu_1", is_error: true, output: "boom", sub: true }),
      ),
    ).toEqual({ toolUseId: "toolu_1", isError: true, output: "boom", sub: true });
  });
  it("defaults sub to false when absent", () => {
    expect(parseToolResult(JSON.stringify({ tool_use_id: "toolu_2", output: "ok" }))).toEqual({
      toolUseId: "toolu_2",
      isError: false,
      output: "ok",
      sub: false,
    });
  });
  it("defaults safely on malformed JSON or missing fields", () => {
    expect(parseToolResult("nope")).toEqual({
      toolUseId: "",
      isError: false,
      output: "",
      sub: false,
    });
    expect(parseToolResult(JSON.stringify({ output: 42 }))).toEqual({
      toolUseId: "",
      isError: false,
      output: "",
      sub: false,
    });
  });
});

describe("parseTask", () => {
  it("parses subtype, task_id, description, tool_use_id", () => {
    expect(
      parseTask(
        JSON.stringify({
          subtype: "task_started",
          task_id: "t1",
          description: "build",
          tool_use_id: "toolu_9",
        }),
      ),
    ).toEqual({
      subtype: "task_started",
      taskId: "t1",
      description: "build",
      toolUseId: "toolu_9",
    });
  });
  it("defaults tool_use_id to empty when absent", () => {
    expect(
      parseTask(JSON.stringify({ subtype: "task_updated", task_id: "t2", description: "x" })),
    ).toEqual({ subtype: "task_updated", taskId: "t2", description: "x", toolUseId: "" });
  });
  it("defaults safely on bad JSON", () => {
    expect(parseTask("{")).toEqual({ subtype: "", taskId: "", description: "", toolUseId: "" });
  });
});

describe("toolHint", () => {
  it("prefers a Bash command", () => {
    expect(toolHint({ command: "rm -rf build", description: "clean" })).toBe("rm -rf build");
  });
  it("falls back to file_path then description", () => {
    expect(toolHint({ file_path: "/a/b.ts", description: "edit" })).toBe("/a/b.ts");
    expect(toolHint({ description: "spawn an agent" })).toBe("spawn an agent");
  });
  it("is empty when there's nothing to show", () => {
    expect(toolHint({})).toBe("");
  });
});

describe("basename / dirname", () => {
  it("splits a normal path", () => {
    expect(basename("/a/b/c.ts")).toBe("c.ts");
    expect(dirname("/a/b/c.ts")).toBe("/a/b");
  });

  it("handles a bare filename (no dir)", () => {
    expect(basename("c.ts")).toBe("c.ts");
    expect(dirname("c.ts")).toBe("");
  });

  it("ignores a trailing slash in basename", () => {
    expect(basename("/a/b/")).toBe("b");
  });

  it("treats a root-level file as having no dir", () => {
    expect(dirname("/c.ts")).toBe("");
  });
});
