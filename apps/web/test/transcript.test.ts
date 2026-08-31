import { describe, expect, it } from "vitest";
import {
  basename,
  diffOf,
  dirname,
  editStat,
  groupTranscriptActivity,
  isSlashCommand,
  parseQuestions,
  parseTask,
  parseToolResult,
  parseToolUse,
  sanitizeInput,
  summarizeActivity,
  toolHint,
} from "../app/lib/transcript.js";
import type { Message } from "../app/lib/viewer.js";

const message = (kind: string, msgId: string, seq: number, text = ""): Message => ({
  kind,
  msgId,
  seq,
  text,
});

describe("groupTranscriptActivity", () => {
  it("rolls up maximal routine runs while preserving exact order and hard boundaries", () => {
    const messages = [
      message("assistant", "a", 1),
      message("tool_use", "t1", 2),
      message("tool_result", "r1", 3, JSON.stringify({ output: "ok" })),
      message("tool_use", "t2", 4),
      message("task", "k1", 5),
      message("assistant_sub", "a2", 6),
      message("tool_use", "t3", 7),
      message("tool_result", "r2", 8, JSON.stringify({ output: "nested" })),
      message("tool_result", "err", 9, JSON.stringify({ output: "boom", is_error: true })),
      message("result", "done", 10),
    ];

    const items = groupTranscriptActivity(messages);
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "activity_group",
      "message",
      "activity_group",
      "message",
      "message",
    ]);
    expect(items[1]?.kind === "activity_group" && items[1].messages.map((m) => m.msgId)).toEqual([
      "t1",
      "r1",
      "t2",
      "k1",
    ]);
    expect(items[3]?.kind === "activity_group" && items[3].messages.map((m) => m.msgId)).toEqual([
      "t3",
      "r2",
    ]);
    // An explicit error remains a first-class transcript row, never hidden in routine activity.
    expect(items[4]?.kind === "message" && items[4].message.msgId).toBe("err");
  });

  it("rolls up from the first event and treats an empty result as a boundary", () => {
    const items = groupTranscriptActivity([
      message("tool_use", "only", 1),
      message("tool_result", "empty", 2, JSON.stringify({ output: "" })),
      message("task", "later", 3),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["activity_group", "message", "activity_group"]);
  });

  it("keeps a stable id as a live singleton grows into a multi-event run", () => {
    const first = message("tool_use", "first", 7);
    const second = message("task", "second", 8);
    const before = groupTranscriptActivity([first])[0];
    const after = groupTranscriptActivity([first, second])[0];
    expect(before?.kind).toBe("activity_group");
    expect(after?.kind).toBe("activity_group");
    if (before?.kind === "activity_group" && after?.kind === "activity_group") {
      expect(after.id).toBe(before.id);
    }
  });

  it("summarizes exact frame counts with correct singular and plural labels", () => {
    expect(
      summarizeActivity([
        message("tool_use", "t1", 1),
        message("tool_use", "t2", 2),
        message("tool_result", "r", 3, JSON.stringify({ output: "ok" })),
        message("task", "k", 4),
      ]),
    ).toBe("2 tool calls · 1 tool result · 1 task event");
  });
});

// parseQuestions reads an AskUserQuestion tool input (#42) — the exact shape captured live via
// --rc-trace: {questions:[{question, header, options:[{label,description}], multiSelect}]}.
describe("parseQuestions", () => {
  it("parses the real captured AskUserQuestion shape", () => {
    const input = {
      questions: [
        {
          question: "What would you like to dig into next on remote-claw?",
          header: "Next up",
          multiSelect: false,
          options: [
            { label: "Continue cli-2-trace-mitm", description: "Keep iterating." },
            { label: "Start something new", description: "Pick a fresh task." },
          ],
        },
      ],
    };
    const qs = parseQuestions(input);
    expect(qs).toHaveLength(1);
    expect(qs[0]?.header).toBe("Next up");
    expect(qs[0]?.multiSelect).toBe(false);
    expect(qs[0]?.options.map((o) => o.label)).toEqual([
      "Continue cli-2-trace-mitm",
      "Start something new",
    ]);
  });

  it("carries multiSelect and drops malformed/empty-label entries", () => {
    const qs = parseQuestions({
      questions: [
        {
          question: "Pick any",
          header: "H",
          multiSelect: true,
          options: [{ label: "a" }, { x: 1 }],
        },
        { question: "", options: [{ label: "z" }] }, // no question text → dropped
        { question: "no opts", options: [] }, // no options → dropped
      ],
    });
    expect(qs).toHaveLength(1);
    expect(qs[0]?.multiSelect).toBe(true);
    expect(qs[0]?.options.map((o) => o.label)).toEqual(["a"]); // the {x:1} option (no label) dropped
  });

  it("returns [] for a non-AskUserQuestion input", () => {
    expect(parseQuestions({ command: "ls" })).toEqual([]);
    expect(parseQuestions(null)).toEqual([]);
    expect(parseQuestions({ questions: "nope" })).toEqual([]);
  });
});

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
