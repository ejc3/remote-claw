import { randomUUID } from "node:crypto";
import type { Session } from "../session.js";
import {
  type AnthropicRcEvent,
  parseBashInput,
  parseFileInput,
  parseNativeAnswers,
  parseNativeQuestions,
  type RcBashInput,
  type RcCommandResponseInput,
  type RcFileToolInput,
  type RcPostAck,
  type RcQuestion,
  type RcQuestionResponseInput,
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
    | { kind: "question"; questionIds: string[]; questions: RcQuestion[] }
    | { kind: "bash"; input: RcBashInput }
    | { kind: "file"; file: RcFileToolInput }
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

/** Captured native questions and one-time Bash/file decisions. Other forms and policy stay native-owned.
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
      // Leave the request with that peer until worker completion, without guessing which peer won.
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
    } else if (
      request.tool_name === "Read" ||
      request.tool_name === "Write" ||
      request.tool_name === "Edit"
    ) {
      if (
        !keys(request, [
          "subtype",
          "tool_name",
          "display_name",
          "description",
          "tool_use_id",
          "input",
          "permission_suggestions",
        ]) ||
        request.display_name !== request.tool_name ||
        !text(request.description, 4096) ||
        !filePermissionSuggestions(request.permission_suggestions, request.tool_name)
      )
        return;
      const file = parseFileInput(request.tool_name, request.input);
      if (file === null) return;
      form = { ...identity, kind: "file", file };
      projectedInput = { nativeFile: true, ...file.input };
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
        !keys(input, ["questions"])
      )
        return;
      const questions = parseNativeQuestions(input.questions);
      if (questions === null) return;
      const questionIds = questions.map(() => randomUUID());
      form = { ...identity, kind: "question", questionIds, questions };
      projectedInput = {
        nativeQuestions: true,
        // Native Skip is per question, with the same single-string / multi-array answer shape.
        allowSkip: true,
        questions: questions.map((question, index) => ({
          ...question,
          id: questionIds[index],
          allowFreeText: true,
        })),
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
    if (form.kind === "bash" || form.kind === "file") {
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
          ...(behavior === "deny"
            ? { behavior, ...(form.kind === "file" ? { toolName: form.file.toolName } : {}) }
            : form.kind === "file"
              ? { behavior, ...form.file }
              : { behavior, input: form.input }),
        },
        { signal },
      );
      return;
    }
    const input = record(result?.updatedInput);
    const answers = record(input?.answers);
    if (result?.behavior !== "allow" || answers === null) return;
    if (
      Object.keys(answers).length !== form.questionIds.length ||
      !form.questionIds.every((id) => Object.hasOwn(answers, id))
    )
      return;
    const selected = parseNativeAnswers(
      form.questions,
      form.questionIds.map((id) => answers[id]),
    );
    if (selected === null) return;
    // Ignore viewer-provided tool IDs/questions: only the recorded native snapshot crosses the POST.
    form.submitted = true;
    await this.client.postQuestionResponse(
      this.nativeId,
      {
        uuid: randomUUID(),
        requestId: form.requestId,
        toolUseId: form.toolUseId,
        questions: form.questions,
        answers: selected,
      },
      { signal },
    );
  }
}

/** Bounded captured suggestions are metadata only: never publish or apply their policy changes. */
function filePermissionSuggestions(value: unknown, toolName: RcFileToolInput["toolName"]): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 8192) return false;
  } catch {
    return false;
  }
  return value.every((item) => {
    const suggestion = record(item);
    if (suggestion?.destination !== "session") return false;
    if (toolName === "Read") {
      if (
        !keys(suggestion, ["type", "destination", "behavior", "rules"]) ||
        suggestion.type !== "addRules" ||
        suggestion.behavior !== "allow" ||
        !Array.isArray(suggestion.rules) ||
        suggestion.rules.length < 1 ||
        suggestion.rules.length > 4
      )
        return false;
      return suggestion.rules.every((value) => {
        const rule = record(value);
        return (
          rule !== null &&
          keys(rule, ["toolName", "ruleContent"]) &&
          rule.toolName === "Read" &&
          text(rule.ruleContent, 4096)
        );
      });
    }
    if (suggestion.type === "setMode")
      return keys(suggestion, ["type", "destination", "mode"]) && suggestion.mode === "acceptEdits";
    return (
      suggestion.type === "addDirectories" &&
      keys(suggestion, ["type", "destination", "directories"]) &&
      Array.isArray(suggestion.directories) &&
      suggestion.directories.length > 0 &&
      suggestion.directories.length <= 4 &&
      suggestion.directories.every((directory) => text(directory, 4096))
    );
  });
}
