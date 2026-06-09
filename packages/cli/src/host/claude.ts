// The real claude backend: drives a live, multi-turn `claude` session over its stream-json SDK
// transport (`--print --verbose --input-format stream-json --output-format stream-json`). User
// messages go in as NDJSON; assistant text + the turn `result` come back as NDJSON. The session
// process stays alive across turns, so context persists (turn 2 remembers turn 1). This is the
// real model behind HostRelay — no MITM, no proxy.
//
// INFERENCE-AGNOSTIC: the host only reads claude's stdout, so it doesn't care WHERE inference runs.
// Point a session at Amazon Bedrock (or Vertex) by passing the backend's own env through — e.g.
// `{ bedrock: true, env: { AWS_REGION: "us-west-2" } }` sets CLAUDE_CODE_USE_BEDROCK=1, and claude
// routes inference to Bedrock via the AWS SDK while remote-claw relays the session unchanged. The
// extra env is MERGED OVER the host's own env (PATH/HOME/AWS creds preserved); remote-claw never
// reads or logs those creds — claude talks to Bedrock directly.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

/** One thing the host relays out of a claude turn: streamed assistant text, then the final result. */
export interface TurnEvent {
  kind: "assistant" | "result";
  text: string;
}

/** What HostRelay needs from a model — a fake stands in for unit tests; ClaudeStreamSession is real. */
export interface ClaudeBackend {
  /** Run one turn for `text`; yields assistant text then a `result`, in order. */
  prompt(text: string): AsyncIterable<TurnEvent>;
  /** Tear down the session. */
  close(): Promise<void>;
}

/** How the session process is launched; injectable so tests can run a fake claude. */
export type ClaudeSpawn = (
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface ClaudeStreamOptions {
  /** Override the claude binary (else "claude"). */
  bin?: string;
  /** Model id; on Bedrock this MUST be an inference-profile id (e.g. "us.anthropic.claude-opus-4-8"). */
  model?: string;
  /** Working directory for the session. */
  cwd?: string;
  /**
   * Extra environment for the claude process, MERGED OVER the host's own env (so PATH/HOME and any
   * AWS credentials survive). This is how a session is pointed at a non-Anthropic inference backend —
   * e.g. `{ AWS_REGION: "us-west-2" }` alongside `bedrock: true`. remote-claw never reads these.
   */
  env?: Record<string, string>;
  /** Shorthand for setting `CLAUDE_CODE_USE_BEDROCK=1` (route inference through Amazon Bedrock). */
  bedrock?: boolean;
  /** Injectable launcher (tests). Defaults to node:child_process spawn. */
  spawnFn?: ClaudeSpawn;
}

const DONE = Symbol("done");

/** A tiny single-consumer async channel: push() from the line reader, next() from prompt(). */
class Channel<T> {
  #buf: T[] = [];
  #waiters: ((v: T | typeof DONE) => void)[] = [];
  #closed = false;

  push(v: T): void {
    const w = this.#waiters.shift();
    if (w !== undefined) w(v);
    else this.#buf.push(v);
  }

  close(): void {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w(DONE);
  }

  next(): Promise<T | typeof DONE> {
    const v = this.#buf.shift();
    if (v !== undefined) return Promise.resolve(v);
    if (this.#closed) return Promise.resolve(DONE);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

export class ClaudeStreamSession implements ClaudeBackend {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #rl: Interface;
  readonly #events = new Channel<TurnEvent>();
  #busy = false;

  constructor(opts: ClaudeStreamOptions = {}) {
    const args = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ];
    if (opts.model !== undefined) args.push("--model", opts.model);

    // Build the child env. Only set `env` at all when we have something to add, so the common case
    // keeps inheriting the host env implicitly. When we do set it, merge OVER process.env so PATH,
    // HOME, and any AWS_* credentials the backend needs are never dropped.
    const extraEnv: Record<string, string> = { ...(opts.env ?? {}) };
    if (opts.bedrock === true) extraEnv.CLAUDE_CODE_USE_BEDROCK = "1";
    const spawnOpts: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
    if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
    if (Object.keys(extraEnv).length > 0) spawnOpts.env = { ...process.env, ...extraEnv };

    const launch: ClaudeSpawn =
      opts.spawnFn ?? ((bin, a, o) => spawn(bin, a, o) as ChildProcessWithoutNullStreams);
    this.#child = launch(opts.bin ?? "claude", args, spawnOpts);
    this.#rl = createInterface({ input: this.#child.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));
    this.#child.on("close", () => this.#events.close());
  }

  /** Parse one NDJSON line; surface only assistant text + the turn result (drop system/hook/rate). */
  #onLine(line: string): void {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const e = ev as { type?: string; message?: { content?: unknown }; result?: unknown };
    if (e.type === "assistant") {
      const content = Array.isArray(e.message?.content) ? e.message.content : [];
      const text = content
        .filter((c): c is { type: "text"; text: string } => {
          const cc = c as { type?: string; text?: unknown };
          return cc.type === "text" && typeof cc.text === "string";
        })
        .map((c) => c.text)
        .join("");
      if (text !== "") this.#events.push({ kind: "assistant", text });
    } else if (e.type === "result") {
      this.#events.push({ kind: "result", text: typeof e.result === "string" ? e.result : "" });
    }
  }

  async *prompt(text: string): AsyncIterable<TurnEvent> {
    if (this.#busy) throw new Error("ClaudeStreamSession: a turn is already in flight");
    this.#busy = true;
    try {
      this.#child.stdin.write(
        `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
      );
      while (true) {
        const ev = await this.#events.next();
        if (ev === DONE) return; // process exited mid-turn
        yield ev;
        if (ev.kind === "result") return; // turn boundary
      }
    } finally {
      this.#busy = false;
    }
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    this.#rl.close();
    this.#child.kill();
    this.#events.close();
  }
}
