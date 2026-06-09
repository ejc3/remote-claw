// §6A frame taxonomy: which AEAD plane (key) each record_kind rides under. The broker never sees
// this — it's the host/viewer agreement on how to seal/open a frame. Content rides K_session,
// control rides control_key, meta rides K_meta (§4.3). A wrong mapping would just fail AEAD open
// loudly, never silently mis-decrypt.

import type { Plane } from "../security/provider.js";

/** Content frames (the transcript) — sealed under K_session, carry `seq`. */
export const CONTENT_KINDS = new Set([
  "user",
  "assistant",
  "assistant_sub", // a sub-agent's assistant reply (under a parent Task) — §17 sub-agents
  "result",
  "system",
  "status",
  "rate_limit",
  "can_use_tool",
  "tool_use", // a tool call the worker made (incl. `Task` = a sub-agent spawn)
  "permission_request", // a worker can_use_tool surfaced to the viewer to grant/deny (§17.4)
]);

/** Control frames (web → wrapper, `dir:in`) — sealed under control_key. */
export const CONTROL_KINDS = new Set([
  "catch_up",
  "permission",
  "interrupt",
  "set_mode",
  "set_model",
  "command",
  "end",
]);

/** Meta frames (acks + presence) — sealed under K_meta. */
export const META_KINDS = new Set(["accepted", "session_announce"]);

/**
 * The plane (key) a frame of `recordKind` is sealed under (§6A). Throws on an unknown kind rather
 * than guessing — an unrecognized kind must not be silently routed to the wrong key.
 */
export function planeForKind(recordKind: string): Plane {
  if (CONTENT_KINDS.has(recordKind)) return "session";
  if (CONTROL_KINDS.has(recordKind)) return "control";
  if (META_KINDS.has(recordKind)) return "meta";
  throw new Error(`unknown record_kind: ${recordKind}`);
}
