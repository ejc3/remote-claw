// The scripted RC turn the e2e host replays — moved verbatim out of the old /api/dev/seed route so the
// published frames are byte-identical to what that route produced. It exercises every transcript row the
// UI renders (#47 + prior features): prose, a top-level Bash tool_use + its Output, a Task sub-agent with
// nested output (incl. a null content block the relay must survive), an error tool_result, and a final
// result. `withPerm` injects a can_use_tool gate (the UI renders a permission card, #56); `withAskq`
// injects an AskUserQuestion gate (#42).
export function scenario(withPerm: boolean, withAskq = false): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "On it — I'll build, run the tests, then spawn a sub-agent to chase the flake.",
          },
        ],
      },
    },
    // A top-level Bash tool call + its Output (the tool_result the relay used to drop, #47).
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_b1",
            name: "Bash",
            input: { command: "pnpm run build", description: "build the release binary" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_b1",
            content: "> build\n> tsc -p . && vite build\n✓ 214 modules transformed.\n✓ built in 3.42s",
          },
        ],
      },
    },
    // A Task tool call spawns a sub-agent; the system task_started lifecycle makes it visible (#47).
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_task1",
            name: "Task",
            input: {
              description: "reproduce the flaky rc-spine test",
              prompt: "Re-run the rc-spine integration test 20× and report any flake.",
            },
          },
        ],
      },
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "tk1",
      description: "reproduce the flaky rc-spine test",
      tool_use_id: "toolu_task1",
    },
    // The sub-agent's own work nests under the Task (parent_tool_use_id ⇒ *_sub / data-sub).
    {
      type: "assistant",
      parent_tool_use_id: "toolu_task1",
      message: { content: [{ type: "text", text: "Running it 20 times to hunt the flake…" }] },
    },
    {
      type: "assistant",
      parent_tool_use_id: "toolu_task1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_s1",
            name: "Bash",
            input: { command: "for i in $(seq 20); do vitest run rc-spine; done" },
          },
        ],
      },
    },
    // Sub-agent tool_result: tagged sub (nested) AND carrying a null content block — the relay must
    // not crash on the null (codex), and the UI nests the Output under the Task (data-sub).
    {
      type: "user",
      parent_tool_use_id: "toolu_task1",
      message: {
        content: [
          null,
          {
            type: "tool_result",
            tool_use_id: "toolu_s1",
            content: [
              { type: "text", text: "run 20/20: ok — no flake reproduced (stale bus hook token)" },
              null,
            ],
          },
        ],
      },
    },
    // An error tool_result renders red.
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_b1",
            is_error: true,
            content: "error: ENOENT: no such file or directory, open 'dist/manifest.json'",
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "Build is green and the sub-agent couldn't reproduce the flake in 20 runs.",
          },
        ],
      },
    },
    { type: "result", subtype: "success", is_error: false, result: "ok" },
  ];
  if (withPerm) {
    // Inject a can_use_tool gate right after the opening line so the UI renders a permission card
    // (the relay maps it to a permission_request content frame, §17.4). Stable request_id so the e2e
    // can grant it and assert the resolved frame replays on reload.
    events.splice(1, 0, {
      type: "control_request",
      request_id: "perm-e2e-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build && pnpm run build" },
      },
    });
  }
  if (withAskq) {
    // Inject an AskUserQuestion gate (the real shape captured via --rc-trace: tool input under `input`
    // with a sibling `tool_use_id`) so the app-e2e can render the question UI + answer it (#42).
    events.splice(1, 0, {
      type: "control_request",
      request_id: "askq-e2e-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_e2e_q1",
        input: {
          questions: [
            {
              question: "Which name do you like best?",
              header: "Name pick",
              multiSelect: false,
              options: [
                { label: "Orion", description: "A bold, cosmic name." },
                { label: "Sable", description: "Sleek and distinctive." },
              ],
            },
          ],
        },
      },
    });
  }
  return events;
}
