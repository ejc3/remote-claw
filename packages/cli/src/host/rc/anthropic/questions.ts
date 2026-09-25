import { randomUUID } from "node:crypto";
import type { Session } from "../session.js";
import {
  type AnthropicRcEvent,
  parseSingleChoiceQuestion,
  type RcPostAck,
  type RcQuestionResponseInput,
  type RcSingleChoiceQuestion,
} from "./client.js";

interface QuestionClient {
  postQuestionResponse(
    sessionId: string,
    input: RcQuestionResponseInput,
    options: { signal: AbortSignal },
  ): Promise<RcPostAck>;
}

interface NativeQuestion {
  requestId: string;
  toolUseId: string;
  viewerId: string;
  questionId: string;
  question: RcSingleChoiceQuestion;
  submitted: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && value.length <= max && (empty || value.trim() !== "");
}

/** One offered choice only. Native peers keep ownership of free text, skip, and other tools.
 * History never grants authority; losing the live stream with an open form retires the companion. */
export class ClaudeNativeQuestions {
  readonly #seenRequests = new Set<string>();
  readonly #seenTools = new Set<string>();
  readonly #native = new Map<string, NativeQuestion>();
  readonly #viewers = new Map<string, NativeQuestion>();

  constructor(
    readonly session: Session,
    readonly nativeId: string,
    readonly client: QuestionClient,
  ) {}

  get pending(): boolean {
    return this.#native.size > 0;
  }

  observe(event: AnthropicRcEvent, live: boolean): void {
    if (this.session.closed) return;
    const p = event.payload;
    if (event.eventType === "control_response" && event.source === "client") {
      // A peer submission is not a winning decision, but it conservatively consumes our authority.
      // This also leaves native-only free-text/skip paths with that peer until worker completion.
      if (
        p.type !== "control_response" ||
        (p.session_id !== undefined &&
          p.session_id !== this.nativeId &&
          p.session_id !== `session_${this.nativeId.slice(4)}`)
      )
        return;
      const response = record(p.response);
      if (response?.subtype !== "success" || !text(response.request_id, 256)) return;
      const form = this.#native.get(response.request_id);
      if (form !== undefined) form.submitted = true;
      return;
    }
    if (event.source !== "worker" || p.session_id !== this.nativeId) return;
    if (event.eventType === "user" && p.type === "user" && p.parent_tool_use_id === null) {
      const message = record(p.message);
      if (message?.role !== "user" || !Array.isArray(message.content)) return;
      for (const value of message.content) {
        const result = record(value);
        if (result?.type !== "tool_result" || !text(result.tool_use_id, 256)) continue;
        for (const form of this.#native.values()) {
          if (result.tool_use_id !== form.toolUseId) continue;
          this.#native.delete(form.requestId);
          this.#viewers.delete(form.viewerId);
          this.session.pushUpstream({ type: "control_cancel_request", request_id: form.viewerId });
        }
      }
      return;
    }
    if (event.eventType !== "control_request" || p.type !== "control_request") return;
    const request = record(p.request);
    if (request?.subtype !== "can_use_tool" || !text(p.request_id, 256)) return;
    if (this.#seenRequests.has(p.request_id)) return;
    if (this.#seenRequests.size >= 10_000)
      throw new Error("native question identity limit exceeded");
    this.#seenRequests.add(p.request_id);
    if (!text(request.tool_use_id, 256)) return;
    if (this.#seenTools.has(request.tool_use_id)) return;
    this.#seenTools.add(request.tool_use_id);
    if (!live) return;
    const input = record(request.input);
    if (
      !keys(p, ["type", "request_id", "request", "session_id", "uuid"]) ||
      !text(p.uuid, 256) ||
      !keys(request, [
        "subtype",
        "tool_name",
        "display_name",
        "description",
        "requires_user_interaction",
        "tool_use_id",
        "input",
      ]) ||
      request.tool_name !== "AskUserQuestion" ||
      request.display_name !== "AskUserQuestion" ||
      !text(request.description, 4096, true) ||
      request.requires_user_interaction !== true ||
      input === null ||
      !keys(input, ["questions"]) ||
      !Array.isArray(input.questions) ||
      input.questions.length !== 1
    )
      return;
    const parsed = parseSingleChoiceQuestion(input.questions[0]);
    if (parsed === null) return;
    const form: NativeQuestion = {
      requestId: p.request_id,
      toolUseId: request.tool_use_id,
      viewerId: randomUUID(),
      questionId: randomUUID(),
      question: parsed,
      submitted: false,
    };
    this.#native.set(form.requestId, form);
    this.#viewers.set(form.viewerId, form);
    this.session.pushUpstream({
      type: "control_request",
      request_id: form.viewerId,
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          nativeQuestions: true,
          questions: [{ ...parsed, id: form.questionId, allowFreeText: false }],
        },
      },
    });
  }

  async respond(payload: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.session.closed) return;
    const response = record(payload.response);
    if (response?.subtype !== "success" || !text(response.request_id, 256)) return;
    const form = this.#viewers.get(response.request_id);
    const result = record(response.response);
    const input = record(result?.updatedInput);
    const answers = record(input?.answers);
    if (form === undefined || form.submitted || result?.behavior !== "allow" || answers === null)
      return;
    if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, form.questionId)) return;
    const answer = answers[form.questionId];
    if (
      typeof answer !== "string" ||
      !form.question.options.some((option) => option.label === answer)
    )
      return;
    // Ignore viewer-provided tool IDs/questions: only the recorded native snapshot crosses the POST.
    form.submitted = true;
    await this.client.postQuestionResponse(
      this.nativeId,
      {
        uuid: randomUUID(),
        requestId: form.requestId,
        toolUseId: form.toolUseId,
        question: form.question,
        answer,
      },
      { signal },
    );
  }
}
