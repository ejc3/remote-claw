import { randomUUID } from "node:crypto";
import type { Session } from "../session.js";
import {
  type AnthropicRcEvent,
  parseBashInput,
  parseSingleChoiceQuestion,
  type RcBashInput,
  type RcCommandResponseInput,
  type RcPostAck,
  type RcQuestionResponseInput,
  type RcSingleChoiceQuestion,
} from "./client.js";

interface ControlClient {
  postQuestionResponse(
    sessionId: string,
    input: RcQuestionResponseInput,
    options: { signal: AbortSignal },
  ): Promise<RcPostAck>;
  postCommandResponse(
    sessionId: string,
    input: RcCommandResponseInput,
    options: { signal: AbortSignal },
  ): Promise<RcPostAck>;
}

interface NativeControlIdentity {
  requestId: string;
  toolUseId: string;
  viewerId: string;
  submitted: boolean;
}

type NativeControl = NativeControlIdentity &
  (
    | { kind: "question"; questionId: string; question: RcSingleChoiceQuestion }
    | { kind: "bash"; input: RcBashInput }
  );

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

/** One offered choice or one captured Bash decision. Other forms and policy stay native-owned.
 * History never grants authority; losing the live stream with an open request retires the companion. */
export class ClaudeNativeControls {
  readonly #seenRequests = new Set<string>();
  readonly #seenTools = new Set<string>();
  readonly #native = new Map<string, NativeControl>();
  readonly #viewers = new Map<string, NativeControl>();

  constructor(
    readonly session: Session,
    readonly nativeId: string,
    readonly client: ControlClient,
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
      throw new Error("native control identity limit exceeded");
    this.#seenRequests.add(p.request_id);
    if (!text(request.tool_use_id, 256)) return;
    if (this.#seenTools.has(request.tool_use_id)) return;
    this.#seenTools.add(request.tool_use_id);
    if (!live) return;
    if (!keys(p, ["type", "request_id", "request", "session_id", "uuid"]) || !text(p.uuid, 256))
      return;
    const identity: NativeControlIdentity = {
      requestId: p.request_id,
      toolUseId: request.tool_use_id,
      viewerId: randomUUID(),
      submitted: false,
    };
    let form: NativeControl;
    let projectedInput: Record<string, unknown>;
    if (request.tool_name === "Bash") {
      if (
        !keys(request, [
          "subtype",
          "tool_name",
          "display_name",
          "description",
          "tool_use_id",
          "input",
        ]) ||
        request.display_name !== "Bash" ||
        request.description !== ""
      )
        return;
      const input = parseBashInput(request.input);
      if (input === null) return;
      form = { ...identity, kind: "bash", input };
      projectedInput = {
        command: input.command,
        reason: `${input.description}\nWorking directory not provided by Claude.\nAllow applies to this command once; Deny rejects it.`,
      };
    } else {
      const input = record(request.input);
      if (
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
      const question = parseSingleChoiceQuestion(input.questions[0]);
      if (question === null) return;
      form = { ...identity, kind: "question", questionId: randomUUID(), question };
      projectedInput = {
        nativeQuestions: true,
        questions: [{ ...question, id: form.questionId, allowFreeText: false }],
      };
    }
    this.#native.set(form.requestId, form);
    this.#viewers.set(form.viewerId, form);
    this.session.pushUpstream({
      type: "control_request",
      request_id: form.viewerId,
      request: {
        subtype: "can_use_tool",
        tool_name: request.tool_name,
        input: projectedInput,
      },
    });
  }

  async respond(payload: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.session.closed) return;
    const response = record(payload.response);
    if (response?.subtype !== "success" || !text(response.request_id, 256)) return;
    const form = this.#viewers.get(response.request_id);
    const result = record(response.response);
    if (form === undefined || form.submitted) return;
    if (form.kind === "bash") {
      const behavior = result?.behavior;
      if (behavior !== "allow" && behavior !== "deny") return;
      form.submitted = true;
      // Only the retained native input crosses the POST; viewer rewrites and policy are ignored.
      await this.client.postCommandResponse(
        this.nativeId,
        {
          uuid: randomUUID(),
          requestId: form.requestId,
          toolUseId: form.toolUseId,
          ...(behavior === "allow" ? { behavior, input: form.input } : { behavior }),
        },
        { signal },
      );
      return;
    }
    const input = record(result?.updatedInput);
    const answers = record(input?.answers);
    if (result?.behavior !== "allow" || answers === null) return;
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
