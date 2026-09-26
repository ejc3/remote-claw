import { describe, expect, it, vi } from "vitest";
import { Session } from "../session.js";
import type {
  AnthropicRcEvent,
  RcCommandResponseInput,
  RcQuestionResponseInput,
} from "./client.js";
import { ClaudeNativeControls } from "./controls.js";

const NATIVE = "cse_question_fixture";
const QUESTION = {
  header: "Color",
  question: "Which test color?",
  multiSelect: false,
  options: [
    { label: "Blue", description: "Select blue as the test color." },
    { label: "Green", description: "Select green as the test color." },
  ],
};
const BASH = {
  command: "printf 'CLAUDE_APPROVAL_SENTINEL\\n'",
  description: "Print approval test sentinel",
};

function event(
  type: string,
  payload: Record<string, unknown>,
  source: "client" | "worker" = "worker",
): AnthropicRcEvent {
  return {
    eventId: "provider-event",
    eventType: type,
    sequenceNum: "1",
    source,
    createdAt: "2026-09-24T23:56:45.309570Z",
    payload,
    raw: payload,
  };
}

function request(kind: "question" | "bash" = "question"): AnthropicRcEvent {
  return event("control_request", {
    type: "control_request",
    request_id: "native-request",
    session_id: NATIVE,
    uuid: "provider-event",
    request:
      kind === "bash"
        ? {
            subtype: "can_use_tool",
            tool_name: "Bash",
            display_name: "Bash",
            description: "",
            tool_use_id: "native-tool",
            input: { ...BASH },
          }
        : {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            display_name: "AskUserQuestion",
            description: "",
            requires_user_interaction: true,
            tool_use_id: "native-tool",
            input: { questions: [structuredClone(QUESTION)] },
          },
  });
}

function completion(
  toolUseId = "native-tool",
  sessionId = NATIVE,
  source: "client" | "worker" = "worker",
): AnthropicRcEvent {
  return event(
    "user",
    {
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Blue" }],
      },
    },
    source,
  );
}

function setup() {
  const session = new Session("projection", "question", {});
  const post = vi.fn(async (_session: string, _input: RcQuestionResponseInput) => ({
    eventId: "answer-event",
    sequenceNum: "3",
    duplicate: false,
  }));
  const commandPost = vi.fn(async (_session: string, _input: RcCommandResponseInput) => ({
    eventId: "command-event",
    sequenceNum: "3",
    duplicate: false,
  }));
  return {
    session,
    post,
    commandPost,
    controls: new ClaudeNativeControls(session, NATIVE, {
      postQuestionResponse: post,
      postCommandResponse: commandPost,
    }),
  };
}

function answer(session: Session, value: unknown = "Blue"): Record<string, unknown> {
  return answerForm(session, [value]);
}

function answerForm(session: Session, values: readonly unknown[]): Record<string, unknown> {
  const p = session.snapshotUpstream()[0]?.payload;
  const input = (p?.request as { input: { questions: Array<{ id: string }> } }).input;
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: p?.request_id,
      response: {
        behavior: "allow",
        toolUseID: "forged-viewer-tool",
        updatedInput: {
          questions: [{ question: "forged rewrite" }],
          answers: Object.fromEntries(
            input.questions.map((question, index) => [question.id, values[index]]),
          ),
        },
      },
    },
  };
}

function commandAnswer(session: Session, behavior: unknown = "allow"): Record<string, unknown> {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: session.snapshotUpstream()[0]?.payload.request_id,
      response: {
        behavior,
        toolUseID: "forged-viewer-tool",
        updatedInput: { command: "forged rewrite", description: "forged reason" },
        updatedPermissions: [{ type: "allow-everything" }],
      },
    },
  };
}

describe("Claude native controls", () => {
  it("binds four opaque question IDs to the retained native input and exact answer shapes", async () => {
    const h = setup();
    const native = request();
    const questions = [
      { ...structuredClone(QUESTION), question: "__proto__" },
      { ...structuredClone(QUESTION), question: "constructor" },
      {
        ...structuredClone(QUESTION),
        question: "Colors",
        multiSelect: true,
        options: [
          { label: "Alpha, beta", description: "First" },
          { label: "Gamma / delta", description: "Second" },
        ],
      },
      { ...structuredClone(QUESTION), question: "More colors", multiSelect: true },
    ];
    const expected = structuredClone(questions);
    (native.payload.request as Record<string, unknown>).input = { questions };
    h.controls.observe(native, true);
    const projected = (
      h.session.snapshotUpstream()[0]?.payload.request as {
        input: {
          allowSkip: boolean;
          questions: Array<{ id: string; allowFreeText: boolean }>;
        };
      }
    ).input;
    expect(projected.allowSkip).toBe(true);
    expect(new Set(projected.questions.map((question) => question.id)).size).toBe(4);
    expect(projected.questions.every((question) => question.allowFreeText)).toBe(true);
    const values = [
      'Other, "quoted cyan"',
      "[No preference]",
      ["Alpha, beta", "Custom: cyan, magenta"],
      ["Green"],
    ];
    const response = answerForm(h.session, values);
    const option = questions[2]?.options[0];
    if (option === undefined) throw new Error("missing test option");
    option.label = "changed after observation";
    await h.controls.respond(response, new AbortController().signal);
    await h.controls.respond(response, new AbortController().signal);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]?.[1]).toMatchObject({
      requestId: "native-request",
      toolUseId: "native-tool",
      questions: expected,
      answers: values,
    });
    expect(h.controls.pending).toBe(true);
    h.controls.observe(completion(), true);
    expect(h.controls.pending).toBe(false);
  });

  it("advertises captured per-question Skip and preserves single-string / multi-array values", async () => {
    const h = setup();
    const native = request();
    const questions = [QUESTION, { ...QUESTION, question: "Second question", multiSelect: true }];
    (native.payload.request as Record<string, unknown>).input = { questions };
    h.controls.observe(native, true);
    expect(h.session.snapshotUpstream()[0]?.payload.request).toMatchObject({
      input: { allowSkip: true },
    });
    await h.controls.respond(
      answerForm(h.session, ["[No preference]", ["[No preference]"]]),
      new AbortController().signal,
    );
    expect(h.post.mock.calls[0]?.[1]).toMatchObject({
      questions,
      answers: ["[No preference]", ["[No preference]"]],
    });
  });

  it.each([
    "missing",
    "extra",
    "native-wording",
  ] as const)("rejects %s answer keys without consuming authority", async (shape) => {
    const h = setup();
    h.controls.observe(request(), true);
    const bad = answer(h.session);
    const response = bad.response as {
      response: { updatedInput: { answers: Record<string, unknown> } };
    };
    const answers = response.response.updatedInput.answers;
    if (shape !== "extra") for (const key of Object.keys(answers)) delete answers[key];
    if (shape === "extra") answers.extra = "Blue";
    if (shape === "native-wording") answers[QUESTION.question] = "Blue";
    await h.controls.respond(bad, new AbortController().signal);
    expect(h.post).not.toHaveBeenCalled();
    await h.controls.respond(answer(h.session), new AbortController().signal);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("projects the captured shape, posts one native snapshot, and waits for worker completion", async () => {
    const h = setup();
    const native = request();
    h.controls.observe(native, true);
    const frame = h.session.snapshotUpstream()[0]?.payload;
    expect(frame?.request_id).not.toBe("native-request");
    expect(frame?.request).toMatchObject({
      tool_name: "AskUserQuestion",
      input: {
        nativeQuestions: true,
        allowSkip: true,
        questions: [{ ...QUESTION, allowFreeText: true }],
      },
    });
    const input = answer(h.session);
    (native.payload.request as { input: unknown }).input = { questions: [] };
    await h.controls.respond(input, new AbortController().signal);
    await h.controls.respond(input, new AbortController().signal);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]?.[1]).toEqual({
      uuid: expect.any(String),
      requestId: "native-request",
      toolUseId: "native-tool",
      questions: [QUESTION],
      answers: ["Blue"],
    });
    expect(h.controls.pending).toBe(true);
    h.controls.observe(completion(), true);
    expect(h.controls.pending).toBe(false);
    expect(h.session.snapshotUpstream()[1]?.payload).toEqual({
      type: "control_cancel_request",
      request_id: frame?.request_id,
    });
    await h.controls.respond(input, new AbortController().signal);
    h.controls.observe(request(), true);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.session.snapshotUpstream()).toHaveLength(2);
  });

  it.each([
    "question",
    "bash",
  ] as const)("never acquires %s authority from history, a replay, or a reused tool ID", (kind) => {
    const h = setup();
    h.controls.observe(request(kind), false);
    h.controls.observe(request(kind), true);
    const reused = request(kind);
    (reused.payload as Record<string, unknown>).request_id = "different-request";
    h.controls.observe(reused, true);
    expect(h.controls.pending).toBe(false);
    expect(h.session.snapshotUpstream()).toEqual([]);
  });

  it("consumes command authority on a native peer submission without claiming completion", async () => {
    const h = setup();
    h.controls.observe(request("bash"), true);
    h.controls.observe(
      event(
        "control_response",
        {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "native-request",
            response: { behavior: "allow" },
          },
        },
        "client",
      ),
      true,
    );
    await h.controls.respond(commandAnswer(h.session), new AbortController().signal);
    expect(h.commandPost).not.toHaveBeenCalled();
    expect(h.controls.pending).toBe(true);
    expect(h.session.snapshotUpstream()).toHaveLength(1);
    h.controls.observe(completion(), true);
    expect(h.controls.pending).toBe(false);
  });

  it("only the same native worker tool result closes a form", () => {
    const h = setup();
    h.controls.observe(request(), true);
    for (const e of [
      completion("other-tool"),
      completion("native-tool", "cse_other"),
      completion("native-tool", NATIVE, "client"),
      event("result", { type: "result", session_id: NATIVE }),
    ])
      h.controls.observe(e, true);
    expect(h.controls.pending).toBe(true);
    h.controls.observe(completion(), true);
    expect(h.controls.pending).toBe(false);
  });

  it.each(
    [["Blue"], "", " \n", "x".repeat(16_385), null].map((value) => ({ value })),
  )("does not submit unsupported answer $value", async ({ value }) => {
    const h = setup();
    h.controls.observe(request(), true);
    await h.controls.respond(answer(h.session, value), new AbortController().signal);
    expect(h.post).not.toHaveBeenCalled();
  });

  it.each([
    NATIVE,
    `session_${NATIVE.slice(4)}`,
    undefined,
  ])("consumes a peer answer with supported session binding %s", async (sessionId) => {
    const h = setup();
    h.controls.observe(request(), true);
    h.controls.observe(
      event(
        "control_response",
        {
          type: "control_response",
          session_id: sessionId,
          response: { subtype: "success", request_id: "native-request" },
        },
        "client",
      ),
      true,
    );
    await h.controls.respond(answer(h.session), new AbortController().signal);
    expect(h.post).not.toHaveBeenCalled();
  });

  it.each([
    "question",
    "bash",
  ] as const)("consumes %s before an ambiguous write and never retries", async (kind) => {
    const h = setup();
    const post = kind === "question" ? h.post : h.commandPost;
    post.mockRejectedValueOnce(new Error("ambiguous"));
    h.controls.observe(request(kind), true);
    const input = kind === "question" ? answer(h.session) : commandAnswer(h.session);
    await expect(h.controls.respond(input, new AbortController().signal)).rejects.toThrow(
      "ambiguous",
    );
    await h.controls.respond(input, new AbortController().signal);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not write after session closure or cancellation", async () => {
    for (const close of [false, true]) {
      const h = setup();
      h.controls.observe(request(), true);
      const input = answer(h.session);
      const controller = new AbortController();
      if (close) h.session.close("test");
      else controller.abort();
      await h.controls.respond(input, controller.signal);
      expect(h.post).not.toHaveBeenCalled();
    }
  });

  it.each([
    (e: AnthropicRcEvent) => {
      (e as { source: string }).source = "client";
    },
    (e: AnthropicRcEvent) => {
      (e.payload as Record<string, unknown>).session_id = "cse_other";
    },
    (e: AnthropicRcEvent) => {
      delete (e.payload as Record<string, unknown>).session_id;
    },
    (e: AnthropicRcEvent) => {
      (e.payload as Record<string, unknown>).type = "assistant";
    },
    (e: AnthropicRcEvent) => {
      (e.payload.request as Record<string, unknown>).tool_name = "Bash";
    },
    (e: AnthropicRcEvent) => {
      (e.payload.request as Record<string, unknown>).requires_user_interaction = false;
    },
    (e: AnthropicRcEvent) => {
      (e.payload.request as Record<string, unknown>).permission_suggestions = [];
    },
  ])("does not admit untrusted or unsupported native metadata %#", (mutate) => {
    const h = setup();
    const e = request();
    mutate(e);
    h.controls.observe(e, true);
    expect(h.session.snapshotUpstream()).toEqual([]);
  });

  it.each([
    { questions: [] },
    { questions: [QUESTION, QUESTION] },
    { questions: Array.from({ length: 5 }, (_, index) => ({ ...QUESTION, question: `${index}` })) },
    { questions: [{ ...QUESTION, multiSelect: "true" }] },
    { questions: [{ ...QUESTION, isSecret: true }] },
    { questions: [{ ...QUESTION, allowFreeText: true }] },
    { questions: [{ ...QUESTION, preview: "unknown preview" }] },
    { questions: [{ ...QUESTION, annotations: {} }] },
    { questions: [{ ...QUESTION, question: "x".repeat(16_385) }] },
    { questions: [{ ...QUESTION, options: [QUESTION.options[0], QUESTION.options[0]] }] },
    {
      questions: [
        {
          ...QUESTION,
          options: Array.from({ length: 21 }, (_, i) => ({ label: `${i}`, description: "" })),
        },
      ],
    },
    {
      questions: [{ ...QUESTION, options: [{ label: "Blue", description: "", isSecret: false }] }],
    },
  ])("rejects the entire unsupported form %#", (input) => {
    const h = setup();
    const e = request();
    (e.payload.request as Record<string, unknown>).input = input;
    h.controls.observe(e, true);
    expect(h.session.snapshotUpstream()).toEqual([]);
  });

  it.each([
    "allow",
    "deny",
  ] as const)("projects captured Bash and sends %s once until worker completion", async (behavior) => {
    const h = setup();
    const native = request("bash");
    h.controls.observe(native, true);
    const frame = h.session.snapshotUpstream()[0]?.payload;
    expect(frame?.request_id).not.toBe("native-request");
    expect(frame?.request).toEqual({
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: {
        command: BASH.command,
        reason: `${BASH.description}\nWorking directory not provided by Claude.\nAllow applies to this command once; Deny rejects it.`,
      },
    });
    const input = commandAnswer(h.session, behavior);
    (native.payload.request as { input: unknown }).input = { command: "changed native object" };
    await h.controls.respond(input, new AbortController().signal);
    await h.controls.respond(input, new AbortController().signal);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.commandPost).toHaveBeenCalledTimes(1);
    expect(h.commandPost.mock.calls[0]?.slice(0, 2)).toEqual([
      NATIVE,
      {
        uuid: expect.any(String),
        requestId: "native-request",
        toolUseId: "native-tool",
        ...(behavior === "allow" ? { behavior, input: BASH } : { behavior }),
      },
    ]);
    expect(h.controls.pending).toBe(true);
    const done = completion();
    const donePayload = done.payload as Record<string, unknown>;
    donePayload.message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "native-tool",
          is_error: behavior === "deny",
          content: behavior === "deny" ? "Denied by user" : "CLAUDE_APPROVAL_SENTINEL",
        },
      ],
    };
    if (behavior === "deny")
      donePayload.tool_result_meta = [
        { id: "native-tool", non_execution_kind: "user-rejected", user_feedback: "Denied by user" },
      ];
    h.controls.observe(done, true);
    expect(h.controls.pending).toBe(false);
    expect(h.session.snapshotUpstream()[1]?.payload).toEqual({
      type: "control_cancel_request",
      request_id: frame?.request_id,
    });
    h.controls.observe(request("bash"), true);
    await h.controls.respond(input, new AbortController().signal);
    expect(h.commandPost).toHaveBeenCalledTimes(1);
    expect(h.session.snapshotUpstream()).toHaveLength(2);
  });

  it.each([
    null,
    "allow-session",
    "",
    true,
  ])("rejects unsupported Bash decision %s", async (behavior) => {
    const h = setup();
    h.controls.observe(request("bash"), true);
    await h.controls.respond(commandAnswer(h.session, behavior), new AbortController().signal);
    expect(h.commandPost).not.toHaveBeenCalled();
    expect(h.controls.pending).toBe(true);
  });

  it.each([
    { request: { requires_user_interaction: true } },
    { request: { description: "unrendered context" } },
    { request: { permission_suggestions: [] } },
    { request: { display_name: "Other tool" } },
    { input: { cwd: "/unverified" } },
    { input: { run_in_background: true } },
    { input: { dangerouslyDisableSandbox: true } },
    { input: { command: "" } },
    { input: { command: "x".repeat(16_385) } },
    { input: { description: "x".repeat(4097) } },
  ])("keeps unsupported Bash metadata native-owned %#", (extra) => {
    const h = setup();
    const native = request("bash");
    const original = native.payload.request as Record<string, unknown>;
    (native.payload as Record<string, unknown>).request = {
      ...original,
      ...extra.request,
      input: { ...BASH, ...extra.input },
    };
    h.controls.observe(native, true);
    expect(h.session.snapshotUpstream()).toEqual([]);
  });
});
