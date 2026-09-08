import { randomUUID } from "node:crypto";
import type { Session } from "../session.js";
import {
  CODEX_HISTORY_ITEM_LIMIT,
  type CodexClient,
  type CodexRequestId,
  type CodexServerRequest,
} from "./client.js";

interface CommandApproval {
  request: CodexServerRequest;
  viewerId: string;
  deny: "decline" | "cancel";
  submitted: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

/** One native request, one one-shot decision. No policy amendments, stdin, network, file, or question
 * responses. Native resolution owns the terminal state; this helper never guesses who won. */
export class CodexCommandApprovals {
  readonly #native = new Map<CodexRequestId, CommandApproval>();
  readonly #viewers = new Map<string, CommandApproval>();

  constructor(
    readonly session: Session,
    readonly threadId: string,
    readonly client: CodexClient,
  ) {}

  observe(request: CodexServerRequest): void {
    if (this.session.closed || request.method !== "item/commandExecution/requestApproval") return;
    const p = request.params;
    if (
      p.threadId !== this.threadId ||
      p.kind !== "command" ||
      p.environmentId !== "local" ||
      !text(p.turnId, 256) ||
      !text(p.itemId, 256) ||
      !text(p.command, 16_384) ||
      !text(p.cwd, 4096) ||
      !p.cwd.startsWith("/") ||
      (p.reason != null && !text(p.reason, 4096)) ||
      p.networkApprovalContext != null ||
      p.additionalPermissions != null ||
      !Array.isArray(p.availableDecisions) ||
      !p.availableDecisions.includes("accept")
    )
      return;
    const deny = p.availableDecisions.includes("decline")
      ? "decline"
      : p.availableDecisions.includes("cancel")
        ? "cancel"
        : null;
    if (deny === null || this.#native.has(request.id)) return;
    if (this.#native.size >= CODEX_HISTORY_ITEM_LIMIT) {
      throw new Error("Codex pending approval limit exceeded");
    }
    const approval: CommandApproval = {
      request,
      viewerId: randomUUID(),
      deny,
      submitted: false,
    };
    this.#native.set(request.id, approval);
    this.#viewers.set(approval.viewerId, approval);
    this.session.pushUpstream({
      type: "control_request",
      request_id: approval.viewerId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Shell",
        input: {
          command: p.command,
          cwd: p.cwd,
          reason: [
            typeof p.reason === "string" ? p.reason : "",
            `Allow applies to this command only. ${deny === "cancel" ? "Deny cancels the native turn." : "Deny rejects this command."}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    });
  }

  resolve(params: Record<string, unknown>): void {
    if (params.threadId !== this.threadId) return;
    const id = params.requestId;
    if (typeof id !== "string" && typeof id !== "number") return;
    const approval = this.#native.get(id);
    if (approval === undefined) return;
    this.#native.delete(id);
    this.#viewers.delete(approval.viewerId);
    this.session.pushUpstream({ type: "control_cancel_request", request_id: approval.viewerId });
  }

  respond(payload: Record<string, unknown>, signal: AbortSignal): void {
    if (signal.aborted || this.session.closed) return;
    const response = record(payload.response);
    if (response?.subtype !== "success" || typeof response.request_id !== "string") return;
    const approval = this.#viewers.get(response.request_id);
    const behavior = record(response.response)?.behavior;
    if (
      approval === undefined ||
      approval.submitted ||
      (behavior !== "allow" && behavior !== "deny")
    )
      return;
    // Consume locally before touching the transport. An ambiguous write is never retried.
    approval.submitted = true;
    this.client.respondCommandApproval(
      approval.request,
      behavior === "allow" ? "accept" : approval.deny,
      signal,
    );
  }
}
