#!/usr/bin/env node
// Test fixture only (NOT shipped behavior): a fake `claude` stream-json backend that replies to each
// user message with an assistant line echoing selected env vars, so claude.test.ts can prove
// ClaudeStreamSession forwards them (e.g. CLAUDE_CODE_USE_BEDROCK) to the spawned process.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.type !== "user") return;
  const text = `bedrock=${process.env.CLAUDE_CODE_USE_BEDROCK ?? "unset"} region=${process.env.AWS_REGION ?? "unset"}`;
  process.stdout.write(
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`,
  );
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`);
});
