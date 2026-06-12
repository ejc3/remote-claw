import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeStreamSession } from "./claude.js";

// A fake claude (echoes its env) stood up via the injectable spawnFn — so we test env passthrough
// without a real claude, real Bedrock, or child-process stdio pipes.
class FakeClaude extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #env: NodeJS.ProcessEnv;
  #buf = "";
  #closed = false;

  constructor(env: NodeJS.ProcessEnv) {
    super();
    this.#env = env;
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => this.#onInput(String(chunk)));
    this.stdin.on("end", () => this.#close());
  }

  #onInput(chunk: string): void {
    this.#buf += chunk;
    let nl = this.#buf.indexOf("\n");
    while (nl !== -1) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      this.#onLine(line);
      nl = this.#buf.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if ((msg as { type?: unknown }).type !== "user") return;
    const text = `bedrock=${this.#env.CLAUDE_CODE_USE_BEDROCK ?? "unset"} region=${this.#env.AWS_REGION ?? "unset"}`;
    this.stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`,
    );
    this.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`);
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }

  kill(): boolean {
    this.#close();
    return true;
  }
}

function spawnFixture(_bin: string, _args: readonly string[], o: { env?: NodeJS.ProcessEnv }) {
  return new FakeClaude(o.env ?? process.env) as unknown as ChildProcessWithoutNullStreams;
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
