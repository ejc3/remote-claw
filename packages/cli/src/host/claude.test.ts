import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeStreamSession } from "./claude.js";

// A fake claude (echoes its env) stood up via the injectable spawnFn — so we test env passthrough
// without a real claude or real Bedrock.
const fixture = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

function spawnFixture(_bin: string, _args: readonly string[], o: { env?: NodeJS.ProcessEnv }) {
  return spawn(process.execPath, [fixture], o) as ChildProcessWithoutNullStreams;
}

async function firstAssistant(session: ClaudeStreamSession): Promise<string> {
  for await (const ev of session.prompt("ping")) {
    if (ev.kind === "assistant") return ev.text;
  }
  return "";
}

describe("ClaudeStreamSession — inference-backend env passthrough", () => {
  it("forwards bedrock + custom env to the spawned process (merged over the host env)", async () => {
    const session = new ClaudeStreamSession({
      bedrock: true,
      env: { AWS_REGION: "us-test-1" },
      spawnFn: spawnFixture,
    });
    const answer = await firstAssistant(session);
    await session.close();
    // The child saw CLAUDE_CODE_USE_BEDROCK=1 (from `bedrock`) and AWS_REGION (from `env`).
    expect(answer).toBe("bedrock=1 region=us-test-1");
  });

  it("adds only the given env and never auto-enables bedrock", async () => {
    const session = new ClaudeStreamSession({ env: { AWS_REGION: "eu-1" }, spawnFn: spawnFixture });
    const answer = await firstAssistant(session);
    await session.close();
    // AWS_REGION came through; bedrock was NOT requested, so it stays unset (CI env is clean).
    expect(answer).toBe("bedrock=unset region=eu-1");
  });
});
