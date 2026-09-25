import { describe, expect, it, vi } from "vitest";
import { Session } from "../session.js";
import type { AnthropicRcEvent, RcQuestionResponseInput } from "./client.js";
import { ClaudeNativeQuestions } from "./questions.js";

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

function request(): AnthropicRcEvent {
  return event("control_request", {
    type: "control_request",
    request_id: "native-request",
    session_id: NATIVE,
    uuid: "provider-event",
    request: {
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
  return {
    session,
    post,
    questions: new ClaudeNativeQuestions(session, NATIVE, { postQuestionResponse: post }),
  };
}

function answer(session: Session, value: unknown = "Blue"): Record<string, unknown> {
  const p = session.snapshotUpstream()[0]?.payload;
  const input = (p?.request as { input: { questions: Array<{ id: string }> } }).input;
  const id = input.questions[0]?.id ?? "missing";
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: p?.request_id,
      response: {
        behavior: "allow",
        toolUseID: "forged-viewer-tool",
        updatedInput: { questions: [{ question: "forged rewrite" }], answers: { [id]: value } },
      },
    },
  };
}

describe("Claude native single-choice questions", () => {
  it("projects the captured shape, posts one native snapshot, and waits for worker completion", async () => {
    const h = setup();
    const native = request();
    h.questions.observe(native, true);
    const frame = h.session.snapshotUpstream()[0]?.payload;
    expect(frame?.request_id).not.toBe("native-request");
    expect(frame?.request).toMatchObject({
      tool_name: "AskUserQuestion",
      input: { nativeQuestions: true, questions: [{ ...QUESTION, allowFreeText: false }] },
    });
    const input = answer(h.session);
    (native.payload.request as { input: unknown }).input = { questions: [] };
    await h.questions.respond(input, new AbortController().signal);
    await h.questions.respond(input, new AbortController().signal);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]?.[1]).toEqual({
      uuid: expect.any(String),
      requestId: "native-request",
      toolUseId: "native-tool",
      question: QUESTION,
      answer: "Blue",
    });
    expect(h.questions.pending).toBe(true);
    h.questions.observe(completion(), true);
    expect(h.questions.pending).toBe(false);
    expect(h.session.snapshotUpstream()[1]?.payload).toEqual({
      type: "control_cancel_request",
      request_id: frame?.request_id,
    });
    await h.questions.respond(input, new AbortController().signal);
    h.questions.observe(request(), true);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.session.snapshotUpstream()).toHaveLength(2);
  });

  it("never acquires authority from history, a replay, or a reused tool ID", () => {
    const h = setup();
    h.questions.observe(request(), false);
    h.questions.observe(request(), true);
    const reused = request();
    (reused.payload as Record<string, unknown>).request_id = "different-request";
    h.questions.observe(reused, true);
    expect(h.questions.pending).toBe(false);
    expect(h.session.snapshotUpstream()).toEqual([]);
  });

  it("consumes answer authority on a native peer submission without claiming completion", async () => {
    const h = setup();
    h.questions.observe(request(), true);
    h.questions.observe(
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
    await h.questions.respond(answer(h.session), new AbortController().signal);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.questions.pending).toBe(true);
    expect(h.session.snapshotUpstream()).toHaveLength(1);
    h.questions.observe(completion(), true);
    expect(h.questions.pending).toBe(false);
  });

  it("only the same native worker tool result closes a form", () => {
    const h = setup();
    h.questions.observe(request(), true);
    for (const e of [
      completion("other-tool"),
      completion("native-tool", "cse_other"),
      completion("native-tool", NATIVE, "client"),
      event("result", { type: "result", session_id: NATIVE }),
    ])
      h.questions.observe(e, true);
    expect(h.questions.pending).toBe(true);
    h.questions.observe(completion(), true);
    expect(h.questions.pending).toBe(false);
  });

  it.each(
    ["free text", ["Blue"], "", null].map((value) => ({ value })),
  )("does not submit unsupported answer $value", async ({ value }) => {
    const h = setup();
    h.questions.observe(request(), true);
    await h.questions.respond(answer(h.session, value), new AbortController().signal);
    expect(h.post).not.toHaveBeenCalled();
  });

  it.each([
    NATIVE,
    `session_${NATIVE.slice(4)}`,
    undefined,
  ])("consumes a peer answer with supported session binding %s", async (sessionId) => {
    const h = setup();
    h.questions.observe(request(), true);
    h.questions.observe(
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
    await h.questions.respond(answer(h.session), new AbortController().signal);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("consumes before an ambiguous write and never retries", async () => {
    const h = setup();
    h.post.mockRejectedValueOnce(new Error("ambiguous"));
    h.questions.observe(request(), true);
    const input = answer(h.session);
    await expect(h.questions.respond(input, new AbortController().signal)).rejects.toThrow(
      "ambiguous",
    );
    await h.questions.respond(input, new AbortController().signal);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("does not write after session closure or cancellation", async () => {
    for (const close of [false, true]) {
      const h = setup();
      h.questions.observe(request(), true);
      const input = answer(h.session);
      const controller = new AbortController();
      if (close) h.session.close("test");
      else controller.abort();
      await h.questions.respond(input, controller.signal);
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
    h.questions.observe(e, true);
    expect(h.session.snapshotUpstream()).toEqual([]);
  });

  it.each([
    { questions: [] },
    { questions: [QUESTION, QUESTION] },
    { questions: [{ ...QUESTION, multiSelect: true }] },
    { questions: [{ ...QUESTION, isSecret: true }] },
    { questions: [{ ...QUESTION, allowFreeText: true }] },
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
    h.questions.observe(e, true);
    expect(h.session.snapshotUpstream()).toEqual([]);
  });
});
