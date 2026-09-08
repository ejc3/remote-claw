import { describe, expect, it, vi } from "vitest";
import { Session } from "../session.js";
import type { CodexClient, CodexServerRequest } from "./client.js";
import { CodexUserQuestions } from "./questions.js";

const THREAD_ID = "01993d50-6c31-7e11-9f70-3a8d9b5e7201";

function question(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "choice",
    header: "Direction",
    question: "Which direction should this task take?",
    isSecret: false,
    isOther: false,
    options: [
      { label: "First", description: "Use the first approach." },
      { label: "Second", description: "Use the second approach." },
    ],
    ...extra,
  };
}

function request(
  params: Record<string, unknown> = {},
  id: string | number = "native-callback",
): CodexServerRequest {
  return {
    id,
    method: "item/tool/requestUserInput",
    params: {
      threadId: THREAD_ID,
      turnId: "turn-1",
      itemId: "item-1",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [question()],
      ...params,
    },
  };
}

function setup() {
  const session = new Session("question-test", "test", null);
  const respondUserInput = vi.fn<CodexClient["respondUserInput"]>(() => true);
  const client = { respondUserInput } as unknown as CodexClient;
  const questions = new CodexUserQuestions(session, THREAD_ID, client);
  const signal = new AbortController().signal;
  const events = (type: string) =>
    session.snapshotUpstream().filter((event) => event.eventType === type);
  const viewerIds = () =>
    events("control_request").map((event) => {
      const id = event.payload.request_id;
      if (typeof id !== "string") throw new Error("missing form viewer ID");
      return id;
    });
  const viewerId = () => {
    const id = viewerIds()[0];
    if (id === undefined) throw new Error("missing form viewer ID");
    return id;
  };
  const respond = (id: string, answers: unknown = { choice: "First" }, behavior = "allow") =>
    questions.respond(
      {
        response: {
          subtype: "success",
          request_id: id,
          response: { behavior, updatedInput: { answers } },
        },
      },
      signal,
    );
  return { session, questions, signal, events, viewerIds, viewerId, respond, respondUserInput };
}

describe("Codex blocking native input forms", () => {
  it("projects the complete native form and submits one exact callback without inferring a winner", () => {
    const s = setup();
    const native = request();
    s.questions.observe(native);
    const id = s.viewerId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe(native.id);
    expect(s.events("control_request")[0]?.payload).toEqual({
      type: "control_request",
      request_id: id,
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          nativeQuestions: true,
          questions: [
            {
              id: "choice",
              header: "Direction",
              question: "Which direction should this task take?",
              options: question().options,
              multiSelect: false,
              allowFreeText: false,
            },
          ],
        },
      },
    });
    s.respond(id);
    s.respond(id, { choice: "Second" });
    expect(s.respondUserInput).toHaveBeenCalledExactlyOnceWith(
      native,
      { choice: { answers: ["First"] } },
      s.signal,
    );
    expect(s.respondUserInput.mock.calls[0]?.[0]).toBe(native);
    expect(s.events("control_cancel_request")).toEqual([]);
    s.questions.resolve({ threadId: THREAD_ID, requestId: native.id });
    expect(s.events("control_cancel_request").map((event) => event.payload.request_id)).toEqual([
      id,
    ]);
  });

  it.each([
    { threadId: "foreign" },
    { turnId: "" },
    { turnId: "t".repeat(257) },
    { itemId: null },
    { itemId: "i".repeat(257) },
    { isBlocking: false },
    { isBlocking: undefined },
    { questions: null },
    { questions: [] },
    { questions: [question(), question(), question(), question()] },
  ])("leaves an unsupported native request entirely native: %j", (params) => {
    const s = setup();
    s.questions.observe(request(params));
    expect(s.events("control_request")).toEqual([]);
    expect(s.respondUserInput).not.toHaveBeenCalled();
  });

  it.each([
    { id: "" },
    { id: "q".repeat(257) },
    { header: null },
    { header: "h".repeat(257) },
    { question: " " },
    { question: "q".repeat(16_385) },
    { isSecret: true },
    { isSecret: undefined },
    { isOther: undefined },
    { isOther: "true" },
    { options: null },
    { options: [] },
    { options: Array.from({ length: 21 }, (_, i) => ({ label: String(i), description: "" })) },
    { options: [null] },
    { options: [{ label: "", description: "" }] },
    { options: [{ label: "l".repeat(1025), description: "" }] },
    { options: [{ label: "First", description: "d".repeat(4097) }] },
    { options: [{ label: "First" }] },
    {
      options: [
        { label: "Same", description: "one" },
        { label: "Same", description: "two" },
      ],
    },
  ])("rejects the whole group when a later question is unsupported: %j", (extra) => {
    const s = setup();
    s.questions.observe(request({ questions: [question(), question({ id: "second", ...extra })] }));
    expect(s.events("control_request")).toEqual([]);
  });

  it("rejects malformed question entries and duplicate IDs, but permits duplicate prompt text", () => {
    const s = setup();
    for (const questions of [[null], [{}], [question(), question()]]) {
      s.questions.observe(request({ questions }));
    }
    expect(s.events("control_request")).toEqual([]);
    const native = request({ questions: [question(), question({ id: "second" })] });
    s.questions.observe(native);
    s.respond(s.viewerId(), { choice: "First", second: "Second" });
    expect(s.respondUserInput).toHaveBeenCalledExactlyOnceWith(
      native,
      { choice: { answers: ["First"] }, second: { answers: ["Second"] } },
      s.signal,
    );
  });

  it("retains exact boundary values, accepts empty display hints, and ignores deprecated timing", () => {
    const s = setup();
    const native = request({
      turnId: "t".repeat(256),
      itemId: "i".repeat(256),
      autoResolutionMs: 1,
      questions: [
        question({
          id: "q".repeat(256),
          header: "h".repeat(256),
          question: "p".repeat(16_384),
          options: Array.from({ length: 20 }, (_, i) => ({
            label: String(i).padEnd(1024, "l"),
            description: "d".repeat(4096),
          })),
        }),
        question({ id: "second", header: "", options: [{ label: "Only", description: "" }] }),
        question({ id: "third" }),
      ],
    });
    s.questions.observe(native);
    expect(s.viewerIds()).toHaveLength(1);
    s.respond(s.viewerId(), {
      ["q".repeat(256)]: "0".padEnd(1024, "l"),
      second: "Only",
      third: "First",
    });
    expect(s.respondUserInput).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { choice: "First", extra: "Second" },
    { other: "First" },
    { choice: ["First"] },
    { choice: {} },
    { choice: "" },
    { choice: "  " },
    { choice: "x".repeat(16_385) },
    { choice: "Unknown" },
    Object.assign(Object.create({ choice: "First" }), { inherited: "not an answer" }),
  ])("does not consume a form for malformed or unoffered answers: %j", (answers) => {
    const s = setup();
    const native = request();
    s.questions.observe(native);
    // Explicit undefined must not use the helper's default valid answer.
    s.questions.respond(
      {
        response: {
          subtype: "success",
          request_id: s.viewerId(),
          response: { behavior: "allow", updatedInput: { answers } },
        },
      },
      s.signal,
    );
    expect(s.respondUserInput).not.toHaveBeenCalled();
    s.respond(s.viewerId());
    expect(s.respondUserInput).toHaveBeenCalledTimes(1);
  });

  it("validates every answer before a whole-group send and permits only explicitly offered free text", () => {
    const s = setup();
    const native = request({
      questions: [question(), question({ id: "custom", isOther: true })],
    });
    s.questions.observe(native);
    s.respond(s.viewerId(), { choice: "Unknown", custom: "Free text" });
    s.respond(s.viewerId(), { choice: "First", custom: " " });
    s.respond(s.viewerId(), { choice: "First", custom: "x".repeat(16_385) });
    expect(s.respondUserInput).not.toHaveBeenCalled();
    const answer = "a".repeat(16_384);
    s.respond(s.viewerId(), { choice: "First", custom: answer });
    expect(s.respondUserInput).toHaveBeenCalledExactlyOnceWith(
      native,
      { choice: { answers: ["First"] }, custom: { answers: [answer] } },
      s.signal,
    );
    expect(JSON.stringify(s.session.snapshotUpstream())).not.toContain(answer);
  });

  it("preserves own-key native IDs including prototype-like names without interpreting them", () => {
    const s = setup();
    const ids = ["__proto__", "constructor", "toString"];
    const native = request({ questions: ids.map((id) => question({ id })) });
    s.questions.observe(native);
    s.respond(s.viewerId(), Object.fromEntries(ids.map((id) => [id, "First"])));
    const answers = s.respondUserInput.mock.calls[0]?.[1];
    expect(Object.keys(answers ?? {})).toEqual(ids);
    for (const id of ids) {
      expect(Object.hasOwn(answers ?? {}, id)).toBe(true);
      expect(answers?.[id]).toEqual({ answers: ["First"] });
    }
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype);
  });

  it("keeps typed native callbacks distinct, deduplicates replay, and honors only matching resolution", () => {
    const s = setup();
    const first = request({}, 7);
    const second = request({}, "7");
    s.questions.observe(first);
    s.questions.observe(first);
    s.questions.observe(second);
    expect(s.viewerIds()).toHaveLength(2);
    const [one, two] = s.viewerIds();
    if (one === undefined || two === undefined) throw new Error("missing viewer IDs");
    s.questions.resolve({ threadId: "foreign", requestId: 7 });
    s.questions.resolve({ threadId: THREAD_ID, requestId: "unknown" });
    expect(s.events("control_cancel_request")).toEqual([]);
    s.questions.resolve({ threadId: THREAD_ID, requestId: 7 });
    s.questions.resolve({ threadId: THREAD_ID, requestId: 7 });
    s.respond(one);
    expect(s.respondUserInput).not.toHaveBeenCalled();
    s.respond(two);
    expect(s.respondUserInput).toHaveBeenCalledExactlyOnceWith(
      second,
      { choice: { answers: ["First"] } },
      s.signal,
    );
    expect(s.events("control_cancel_request")).toHaveLength(1);
  });

  it("does not accept native IDs, previous-projection IDs, Dismiss, or malformed control responses", () => {
    const prior = setup();
    prior.questions.observe(request());
    const s = setup();
    s.questions.observe(request());
    s.respond("native-callback");
    s.respond(prior.viewerId());
    s.respond(s.viewerId(), { choice: "First" }, "deny");
    s.questions.respond({ response: { subtype: "error", request_id: s.viewerId() } }, s.signal);
    s.questions.respond({ response: [] }, s.signal);
    expect(s.respondUserInput).not.toHaveBeenCalled();
    s.respond(s.viewerId());
    expect(s.respondUserInput).toHaveBeenCalledTimes(1);
  });

  it.each(["closed", "aborted"])("does not answer after %s", (state) => {
    const s = setup();
    s.questions.observe(request());
    const id = s.viewerId();
    const controller = new AbortController();
    if (state === "closed") s.session.close();
    else controller.abort();
    s.questions.respond(
      {
        response: {
          subtype: "success",
          request_id: id,
          response: { behavior: "allow", updatedInput: { answers: { choice: "First" } } },
        },
      },
      controller.signal,
    );
    expect(s.respondUserInput).not.toHaveBeenCalled();
  });

  it("never handles another response family or projects after closure", () => {
    const s = setup();
    for (const method of [
      "mcpServer/elicitation/request",
      "item/commandExecution/requestApproval",
      "item/permissions/requestApproval",
    ]) {
      s.questions.observe({ ...request(), method });
    }
    s.session.close();
    s.questions.observe(request());
    expect(s.events("control_request")).toEqual([]);
  });

  it("consumes stale or ambiguous native submissions without retrying or fabricating resolution", () => {
    for (const outcome of ["stale", "ambiguous"]) {
      const s = setup();
      s.questions.observe(request());
      s.respondUserInput.mockImplementation(() => {
        if (outcome === "ambiguous") throw new Error("unknown write outcome");
        return false;
      });
      if (outcome === "ambiguous") {
        expect(() => s.respond(s.viewerId())).toThrow("unknown write outcome");
      } else s.respond(s.viewerId());
      s.respond(s.viewerId());
      expect(s.respondUserInput).toHaveBeenCalledTimes(1);
      expect(s.events("control_cancel_request")).toEqual([]);
    }
  });
});
