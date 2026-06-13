import { describe, expect, it } from "vitest";
import {
  type Part,
  coalesceMessage,
  partToBlocks,
  userText,
} from "./translate.js";

// Golden fixtures: each Part shape mirrors the live `opencode serve` GET /doc Part schemas (verified by
// curling the server). The assertions PIN the exact content-block JSON the relay's mapUpstreamItems
// consumes — so a drift in the mapping fails here, not silently at the relay (which drops bad frames).

describe("partToBlocks", () => {
  it("TextPart → a single text block", () => {
    const part: Part = { type: "text", id: "prt_1", text: "hello" };
    expect(partToBlocks(part)).toEqual({
      assistant: [{ type: "text", text: "hello" }],
      toolResults: [],
    });
  });

  it("drops empty text and synthetic text (the user-prompt echo)", () => {
    expect(partToBlocks({ type: "text", id: "prt_e", text: "" })).toEqual({
      assistant: [],
      toolResults: [],
    });
    expect(
      partToBlocks({ type: "text", id: "prt_s", text: "Reply with exactly: OK", synthetic: true }),
    ).toEqual({ assistant: [], toolResults: [] });
  });

  it("ReasoningPart → a thinking block; whitespace-only reasoning dropped", () => {
    expect(partToBlocks({ type: "reasoning", id: "prt_r", text: "let me think" })).toEqual({
      assistant: [{ type: "thinking", thinking: "let me think" }],
      toolResults: [],
    });
    expect(partToBlocks({ type: "reasoning", id: "prt_w", text: "   \n " })).toEqual({
      assistant: [],
      toolResults: [],
    });
  });

  it("ToolPart pending/running → tool_use only (no result yet)", () => {
    const running: Part = {
      type: "tool",
      id: "prt_t",
      callID: "call_42",
      tool: "Bash",
      state: { status: "running", input: { command: "ls" } },
    };
    expect(partToBlocks(running)).toEqual({
      assistant: [{ type: "tool_use", name: "Bash", input: { command: "ls" }, id: "call_42" }],
      toolResults: [],
    });
  });

  it("ToolPart completed → tool_use + a (non-error) tool_result", () => {
    const done: Part = {
      type: "tool",
      id: "prt_t",
      callID: "call_42",
      tool: "Bash",
      state: { status: "completed", input: { command: "ls" }, output: "file.txt\n" },
    };
    expect(partToBlocks(done)).toEqual({
      assistant: [{ type: "tool_use", name: "Bash", input: { command: "ls" }, id: "call_42" }],
      toolResults: [
        { type: "tool_result", tool_use_id: "call_42", content: "file.txt\n", is_error: false },
      ],
    });
  });

  it("ToolPart error → tool_use + an is_error tool_result carrying the error text", () => {
    const failed: Part = {
      type: "tool",
      id: "prt_t",
      callID: "call_7",
      tool: "Bash",
      state: { status: "error", input: { command: "nope" }, error: "command not found" },
    };
    expect(partToBlocks(failed)).toEqual({
      assistant: [{ type: "tool_use", name: "Bash", input: { command: "nope" }, id: "call_7" }],
      toolResults: [
        { type: "tool_result", tool_use_id: "call_7", content: "command not found", is_error: true },
      ],
    });
  });

  it("drops step/snapshot/patch/agent/retry/compaction/file/subtask/unknown parts", () => {
    for (const t of [
      "step-start",
      "step-finish",
      "snapshot",
      "patch",
      "agent",
      "retry",
      "compaction",
      "file",
      "subtask",
      "totally-new",
    ]) {
      expect(partToBlocks({ type: t, id: "prt_x" })).toEqual({ assistant: [], toolResults: [] });
    }
  });
});

describe("coalesceMessage", () => {
  it("one assistant payload for a text-only message (uuid = messageID)", () => {
    const parts: Part[] = [
      { type: "step-start", id: "prt_s" },
      { type: "text", id: "prt_1", text: "OK" },
      { type: "step-finish", id: "prt_f" },
    ];
    expect(coalesceMessage("msg_abc", parts)).toEqual([
      {
        type: "assistant",
        uuid: "msg_abc",
        message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
      },
    ]);
  });

  it("splits a tool turn into an assistant (tool_use) and a following user (tool_result)", () => {
    const parts: Part[] = [
      { type: "text", id: "prt_1", text: "running it" },
      {
        type: "tool",
        id: "prt_t",
        callID: "call_42",
        tool: "Bash",
        state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
      },
    ];
    const out = coalesceMessage("msg_xyz", parts);
    expect(out).toEqual([
      {
        type: "assistant",
        uuid: "msg_xyz",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running it" },
            { type: "tool_use", name: "Bash", input: { command: "ls" }, id: "call_42" },
          ],
        },
      },
      {
        type: "user",
        uuid: "msg_xyz-toolresults",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_42", content: "file.txt", is_error: false },
          ],
        },
      },
    ]);
  });

  it("emits nothing for a message with no renderable content", () => {
    expect(coalesceMessage("msg_empty", [{ type: "step-start", id: "prt_s" }])).toEqual([]);
  });

  it("tags sub-agent messages with parent_tool_use_id on every payload", () => {
    const parts: Part[] = [
      { type: "text", id: "prt_1", text: "sub work" },
      {
        type: "tool",
        id: "prt_t",
        callID: "c1",
        tool: "Read",
        state: { status: "completed", input: {}, output: "x" },
      },
    ];
    const out = coalesceMessage("msg_sub", parts, { parentToolUseId: "task_99" });
    expect(out.map((p) => p.parent_tool_use_id)).toEqual(["task_99", "task_99"]);
  });
});

describe("userText", () => {
  it("reads the relay's pushUserInput shape (message.content string)", () => {
    expect(userText({ message: { role: "user", content: "hi there" } })).toBe("hi there");
  });
  it("falls back to a top-level text field, else empty string", () => {
    expect(userText({ text: "fallback" })).toBe("fallback");
    expect(userText({})).toBe("");
    expect(userText({ message: { content: 123 } })).toBe("");
  });
});
