// PURE translation layer: OpenCode `Part`s ⇄ claude canonical content blocks (the UpstreamPayload the
// relay's `mapUpstreamItems` consumes verbatim). No I/O, no globals — every function here is a total
// function of its inputs so the golden-fixture unit tests pin the mapping exactly. The driver
// (driver.ts) does the buffering/coalescing/dedup; this file only decides "given these completed parts,
// what content blocks + UpstreamPayloads does claude's protocol expect".
//
// Why faithful by construction: this mirrors the inverse of OpenCode's own message→Anthropic conversion
// (message-v2.ts:toModelMessagesEffect). A `ToolPart` carries one logical tool call whose lifecycle is
// `pending → running → completed|error`. claude splits that into TWO messages: a `tool_use` block on the
// assistant message and a `tool_result` block on a FOLLOWING user message. So a completed assistant
// message with tool calls coalesces into up to two UpstreamPayloads (assistant, then user).

import type { ContentBlock, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from "../driver.js";

/** The OpenCode `Part` shapes the driver acts on (the load-bearing subset of the Part union — verified
 *  against the live server's GET /doc OpenAPI). Fields we don't read are left off; an `unknown`-typed
 *  `state.input`/`output` keeps us honest (model-authored JSON is untrusted). */
export interface TextPart {
  type: "text";
  id: string;
  text: string;
  /** OpenCode marks the user prompt-echo + tool-synthesized text as `synthetic`; we drop those (the
   *  relay already echoes viewer prompts, and synthetic assistant text would double-render). */
  synthetic?: boolean;
}

export interface ReasoningPart {
  type: "reasoning";
  id: string;
  text: string;
}

export type ToolStatus = "pending" | "running" | "completed" | "error";

export interface ToolState {
  status: ToolStatus;
  input?: unknown;
  /** present when status==="completed" */
  output?: string;
  /** present when status==="error" */
  error?: string;
}

export interface ToolPart {
  type: "tool";
  id: string;
  callID: string;
  tool: string;
  state: ToolState;
}

/** Parts the driver deliberately drops (turn boundaries / housekeeping / not-yet-supported), kept here
 *  so `partToBlocks` can name them explicitly rather than via a silent default. */
export interface OtherPart {
  type:
    | "step-start"
    | "step-finish"
    | "snapshot"
    | "patch"
    | "agent"
    | "retry"
    | "compaction"
    | "file"
    | "subtask"
    | string;
  id: string;
  [k: string]: unknown;
}

export type Part = TextPart | ReasoningPart | ToolPart | OtherPart;

/** A part's translation: blocks that belong on the ASSISTANT message and (for completed tool calls)
 *  blocks that belong on the FOLLOWING user message (tool_result). claude's protocol keeps these on
 *  separate role messages, so we keep them separate here and the coalescer assembles the two payloads. */
export interface PartBlocks {
  assistant: ContentBlock[];
  /** tool_result blocks — go on a user-role message after the assistant message (claude's shape). */
  toolResults: ToolResultBlock[];
}

const EMPTY: PartBlocks = { assistant: [], toolResults: [] };

/**
 * Map ONE OpenCode part → its claude content blocks. Pure; the lifecycle for a ToolPart is encoded as:
 *   • pending|running → a `tool_use` only (the call is in flight; no result yet).
 *   • completed       → a `tool_use` AND a `tool_result` (content = state.output, is_error: false).
 *   • error           → a `tool_use` AND a `tool_result` (content = state.error, is_error: true).
 * Text/reasoning map straight across. Empty/synthetic text → dropped (the relay drops empty text/thinking
 * anyway; dropping synthetic here avoids double-rendering the user prompt echo). Everything else → EMPTY.
 */
export function partToBlocks(part: Part): PartBlocks {
  switch (part.type) {
    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      if (part.synthetic === true || text === "") return EMPTY;
      const block: TextBlock = { type: "text", text };
      return { assistant: [block], toolResults: [] };
    }
    case "reasoning": {
      const thinking = typeof part.text === "string" ? part.text : "";
      if (thinking.trim() === "") return EMPTY;
      const block: ThinkingBlock = { type: "thinking", thinking };
      return { assistant: [block], toolResults: [] };
    }
    case "tool": {
      const st = part.state;
      const toolUse: ToolUseBlock = {
        type: "tool_use",
        name: part.tool,
        input: st.input ?? {},
        id: part.callID,
      };
      if (st.status === "completed") {
        const result: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: part.callID,
          content: typeof st.output === "string" ? st.output : "",
          is_error: false,
        };
        return { assistant: [toolUse], toolResults: [result] };
      }
      if (st.status === "error") {
        const result: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: part.callID,
          content: typeof st.error === "string" ? st.error : "tool failed",
          is_error: true,
        };
        return { assistant: [toolUse], toolResults: [result] };
      }
      // pending / running: the call exists, no result yet.
      return { assistant: [toolUse], toolResults: [] };
    }
    // step boundaries, snapshot, patch, agent, retry, compaction, file, subtask, unknown → dropped here.
    default:
      return EMPTY;
  }
}

/** What the coalescer emits: the canonical UpstreamPayloads to feed `session.pushUpstream`, in order.
 *  The relay allocates a fresh seq per pushUpstream, so this is a SMALL fixed list (assistant, then a
 *  user tool_results message) emitted ONCE per completed message — never per streamed part. */
export interface CoalescedPayload {
  type: "assistant" | "user";
  uuid: string;
  message: { role: "assistant" | "user"; content: ContentBlock[] };
  /** Sub-agent nesting tag (a child-session message under a Task tool_use). Omitted at top level. */
  parent_tool_use_id?: string | null;
}

/** Options that tag a coalesced message for sub-agent nesting (set by the driver when the message comes
 *  from a child OpenCode session spawned under a Task tool_use). */
export interface CoalesceOptions {
  /** The spawning Task's tool_use id — rides on both the assistant and the user payload so the viewer
   *  nests the whole sub-turn under the Task row. */
  parentToolUseId?: string;
}

/**
 * Coalesce a COMPLETED assistant message's parts into the ≤2 UpstreamPayloads claude's protocol uses:
 *   1. an `assistant` message holding all text/thinking/tool_use blocks (uuid = the message id), and
 *   2. (only if any tool completed) a `user` message holding the tool_result blocks.
 * Called ONCE per message on `session.idle`/message-complete — this is the heart of the COALESCE
 * obligation (review #1): never call per `message.part.updated`. Returns [] when the message has no
 * renderable content (e.g. a turn that was only step boundaries), so the driver pushes nothing.
 */
export function coalesceMessage(
  messageId: string,
  parts: readonly Part[],
  opts: CoalesceOptions = {},
): CoalescedPayload[] {
  const assistant: ContentBlock[] = [];
  const toolResults: ToolResultBlock[] = [];
  for (const part of parts) {
    const b = partToBlocks(part);
    assistant.push(...b.assistant);
    toolResults.push(...b.toolResults);
  }
  const out: CoalescedPayload[] = [];
  const tag =
    opts.parentToolUseId !== undefined ? { parent_tool_use_id: opts.parentToolUseId } : {};
  if (assistant.length > 0) {
    out.push({
      type: "assistant",
      uuid: messageId,
      message: { role: "assistant", content: assistant },
      ...tag,
    });
  }
  if (toolResults.length > 0) {
    // A stable, distinct uuid for the tool_result user message (the assistant message owns messageId).
    out.push({
      type: "user",
      uuid: `${messageId}-toolresults`,
      message: { role: "user", content: toolResults },
      ...tag,
    });
  }
  return out;
}

/** Pull the prompt text out of a downstream `user` event payload (the relay's pushUserInput shape:
 *  `{ message: { role:"user", content: <string> } }`). Falls back to a top-level `text`. Returns "" when
 *  there's nothing injectable so the driver can skip an empty prompt rather than POST a blank turn. */
export function userText(payload: Record<string, unknown>): string {
  const message = payload.message as { content?: unknown } | undefined;
  if (message && typeof message.content === "string") return message.content;
  if (typeof payload.text === "string") return payload.text;
  return "";
}
