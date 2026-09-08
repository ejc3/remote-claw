import { randomUUID } from "node:crypto";
import type { Session } from "../session.js";
import {
  CODEX_HISTORY_ITEM_LIMIT,
  type CodexClient,
  type CodexRequestId,
  type CodexServerRequest,
} from "./client.js";

interface Question {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: false;
  allowFreeText: boolean;
}

interface NativeForm {
  request: CodexServerRequest;
  viewerId: string;
  questions: Question[];
  submitted: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.trim() !== "") && value.length <= max;
}

/** Transparent native forms, including any tool-consent wording the native request contains.
 * Never infer planning-only authority, secret-input support, or a local auto-resolution timer. */
export class CodexUserQuestions {
  readonly #native = new Map<CodexRequestId, NativeForm>();
  readonly #viewers = new Map<string, NativeForm>();

  constructor(
    readonly session: Session,
    readonly threadId: string,
    readonly client: CodexClient,
  ) {}

  observe(request: CodexServerRequest): void {
    if (this.session.closed || request.method !== "item/tool/requestUserInput") return;
    const p = request.params;
    if (
      p.threadId !== this.threadId ||
      !text(p.threadId, 256) ||
      !text(p.turnId, 256) ||
      !text(p.itemId, 256) ||
      p.isBlocking !== true ||
      !Array.isArray(p.questions) ||
      p.questions.length < 1 ||
      p.questions.length > 3 ||
      !(
        text(request.id, 256) ||
        (typeof request.id === "number" && Number.isSafeInteger(request.id))
      )
    )
      return;
    const questions: Question[] = [];
    const ids = new Set<string>();
    for (const value of p.questions) {
      const q = record(value);
      if (
        q === null ||
        !text(q.id, 256) ||
        ids.has(q.id) ||
        !text(q.header, 256, true) ||
        !text(q.question, 16_384) ||
        q.isSecret !== false ||
        typeof q.isOther !== "boolean" ||
        !Array.isArray(q.options) ||
        q.options.length < 1 ||
        q.options.length > 20
      )
        return;
      ids.add(q.id);
      const options: Question["options"] = [];
      const labels = new Set<string>();
      for (const value of q.options) {
        const option = record(value);
        if (
          option === null ||
          !text(option.label, 1024) ||
          labels.has(option.label) ||
          !text(option.description, 4096, true)
        )
          return;
        labels.add(option.label);
        options.push({ label: option.label, description: option.description });
      }
      questions.push({
        id: q.id,
        header: q.header,
        question: q.question,
        options,
        multiSelect: false,
        allowFreeText: q.isOther,
      });
    }
    if (this.#native.has(request.id)) return;
    if (this.#native.size >= CODEX_HISTORY_ITEM_LIMIT) {
      throw new Error("Codex pending question limit exceeded");
    }
    const form: NativeForm = { request, viewerId: randomUUID(), questions, submitted: false };
    this.#native.set(request.id, form);
    this.#viewers.set(form.viewerId, form);
    this.session.pushUpstream({
      type: "control_request",
      request_id: form.viewerId,
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { nativeQuestions: true, questions },
      },
    });
  }

  resolve(params: Record<string, unknown>): void {
    if (this.session.closed || params.threadId !== this.threadId) return;
    const id = params.requestId;
    if (typeof id !== "string" && typeof id !== "number") return;
    const form = this.#native.get(id);
    if (form === undefined) return;
    this.#native.delete(id);
    this.#viewers.delete(form.viewerId);
    this.session.pushUpstream({ type: "control_cancel_request", request_id: form.viewerId });
  }

  respond(payload: Record<string, unknown>, signal: AbortSignal): void {
    if (signal.aborted || this.session.closed) return;
    const response = record(payload.response);
    if (response?.subtype !== "success" || typeof response.request_id !== "string") return;
    const form = this.#viewers.get(response.request_id);
    const result = record(response.response);
    const input = record(result?.updatedInput);
    const answers = record(input?.answers);
    if (
      form === undefined ||
      form.submitted ||
      result?.behavior !== "allow" ||
      answers === null ||
      Object.keys(answers).length !== form.questions.length
    )
      return;
    const native: Array<[string, { answers: string[] }]> = [];
    for (const question of form.questions) {
      const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
      if (
        !text(answer, 16_384) ||
        (!question.allowFreeText && !question.options.some((option) => option.label === answer))
      )
        return;
      native.push([question.id, { answers: [answer] }]);
    }
    // One whole-group submission; native resolution, not local intent, dismisses every viewer.
    form.submitted = true;
    this.client.respondUserInput(form.request, Object.fromEntries(native), signal);
  }
}
