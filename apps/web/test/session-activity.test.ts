import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "../app/lib/viewer.js";
import { SessionActivitySheet } from "../app/page.js";

const tool: Message = {
  kind: "tool_use",
  msgId: "call",
  seq: 1,
  text: JSON.stringify({
    id: "command-1",
    name: "Shell",
    input: { command: "sleep 5 && printf done" },
  }),
};
const render = (messages: Message[], connected = true) =>
  renderToStaticMarkup(createElement(SessionActivitySheet, { messages, connected, onClose() {} }));

describe("session activity presentation", () => {
  it("shows an honest empty and disconnected state without native controls", () => {
    const html = render([], false);
    expect(html).toContain("No activity yet.");
    expect(html).toContain("Not connected — showing last received activity.");
    expect(html).not.toContain("Allow");
    expect(html).not.toContain("Stop task");
  });

  it("shows the actual command and only clears missing-result text for its exact native result", () => {
    const unrelated: Message = {
      kind: "tool_result",
      msgId: "result",
      seq: 2,
      text: JSON.stringify({ tool_use_id: "other", output: "" }),
    };
    const pending = render([tool, unrelated]);
    expect(pending).toContain("sleep 5 &amp;&amp; printf done");
    expect(pending).toContain("No result received yet.");
    const resolved = render([
      tool,
      { ...unrelated, text: JSON.stringify({ tool_use_id: "command-1", output: "" }) },
    ]);
    expect(resolved).not.toContain("No result received yet.");
    expect(resolved).toContain("Result received without text output.");
  });

  it("leaves old uncorrelated frames unclassified and keeps error output visible", () => {
    const html = render([
      { ...tool, text: JSON.stringify({ name: "Shell", input: { command: "false" } }) },
      {
        kind: "tool_result",
        msgId: "error",
        seq: 2,
        text: JSON.stringify({
          tool_use_id: "unknown",
          is_error: true,
          output: "Native command declined.",
        }),
      },
    ]);
    expect(html).not.toContain("No result received yet.");
    expect(html).toContain("View error");
    expect(html).toContain("Native command declined.");
  });
});
