// LIVE proof that the tmux driver captures a real sub-agent (Task) and relays it NESTED under the Task
// (matching native RC), not dropped and not flooding the main transcript. Drives real claude 2.1.x in
// tmux, asks it to spawn a Task subagent that replies with a codeword, and asserts an `assistant_sub`
// content frame carrying that codeword reaches the (fake) viewer — `*_sub` is the relay's tag for a
// `parent_tool_use_id`-nested frame. NOT part of the unit suite. Run: pnpm exec tsx tmux-subagent-verify.ts
//
// Flaky in this sandbox (claude TUI boot timing + intermittent transcript writes for driven turns — see
// e2e-tmux-driver.ts) AND the cheap path: the model must actually choose to spawn a Task. Re-run if the
// model answers directly. The capture/nesting mechanism is proven DETERMINISTICALLY in transcript.test.ts
// (agent_progress → nested payload) + driver.test.ts (agent_progress line → assistant_sub frame).

import { execFileSync } from "node:child_process";
import { deriveIdentity, type Frame, type FrameHeader } from "@remote-claw/clawsec";
import type { BrokerClient } from "./src/broker/client.js";
import { runTmuxDriver } from "./src/host/rc/tmux/driver.js";
import { TmuxCtl } from "./src/host/rc/tmux/tmuxctl.js";

const enc = (s: string) => new TextEncoder().encode(s);

class FakeClient {
  posts: Array<{ recordKind: string; seq: number | null; text: string }> = [];
  announces: Record<string, unknown>[] = [];
  #inbound: Frame[] = [];
  #wakes = new Set<() => void>();
  get content() {
    return this.posts.filter((p) => p.seq !== null);
  }
  async seqCursor() {
    return { maxSeq: null, durable: false };
  }
  async frameCountCursor() {
    return { frameCount: this.#inbound.length, durable: false };
  }
  pushInbound(f: Frame): void {
    this.#inbound.push(f);
    for (const w of this.#wakes) w();
    this.#wakes.clear();
  }
  async postMessage(h: FrameHeader, b: Uint8Array) {
    this.posts.push({ recordKind: h.recordKind, seq: h.seq, text: new TextDecoder().decode(b) });
    return [{ ok: true }];
  }
  async postFrame(h: FrameHeader, b: Uint8Array) {
    const text = new TextDecoder().decode(b);
    if (h.recordKind === "session_announce") {
      try {
        this.announces.push(JSON.parse(text));
      } catch {}
    }
    this.posts.push({ recordKind: h.recordKind, seq: h.seq, text });
    return { ok: true };
  }
  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    let cursor = 0;
    for (;;) {
      while (cursor < this.#inbound.length) {
        const f = this.#inbound[cursor++];
        if (f) yield f;
      }
      if (opts.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const w = () => {
          this.#wakes.delete(w);
          resolve();
        };
        this.#wakes.add(w);
        opts.signal?.addEventListener("abort", w, { once: true });
      });
    }
  }
  openFrame(f: Frame): Promise<Uint8Array> {
    return Promise.resolve(f.ct);
  }
}

function inFrame(id: Uint8Array, msgId: string, text: string): Frame {
  return {
    v: 1, identityId: id, sessionId: "s", dir: "in", recordKind: "user", seq: null, msgId,
    keyEpoch: 0, part: 0, parts: 1, salt: new Uint8Array(32), nonce: new Uint8Array(12), ct: enc(text),
  } as Frame;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pane = (n: string): string => {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", n, "-p"], { encoding: "utf8" });
  } catch {
    return "";
  }
};
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(200);
  if (!pred()) throw new Error(`TIMEOUT ${what}`);
}

async function main() {
  const identity = await deriveIdentity(new Uint8Array(32).fill(11));
  const client = new FakeClient();
  const cwd = process.env.E2E_TMUX_CWD ?? "/home/ubuntu/remote-claw";
  const ac = new AbortController();
  let sid = "";
  const CODE = "KIWI";
  // A unique sentinel in the prompt for "did the paste land" — must NOT collide with anything already on
  // screen (e.g. the git branch "feat/tmux-subagents" contains "subagent"!), so use a random-ish token.
  const SENTINEL = "ZQX7PROMPT";
  const prompt =
    `${SENTINEL}: Use the Task tool to launch a general-purpose subagent whose ENTIRE job is to reply ` +
    `with the single word ${CODE} and nothing else. Then tell me what the subagent said.`;

  console.log("[subagent] spawning real claude in tmux (cwd=%s) …", cwd);
  const run = runTmuxDriver(
    {
      harnessArgs: [], identity, brokerUrl: "https://broker.example", title: "subagent-verify",
      cwd, git: null, newClient: () => client as unknown as BrokerClient,
      onSession: (s) => {
        sid = s.id;
      },
    },
    ac.signal,
    {},
  );

  try {
    await waitFor(() => sid !== "", 5000, "onSession");
    const name = `rc-${sid}`;
    await waitFor(() => client.announces.length > 0, 5000, "announce");
    const ready = () => pane(name).includes("bypass permissions on") && pane(name).includes("❯");
    await sleep(12_000);
    await waitFor(ready, 30_000, "input box");
    await sleep(3_000);

    const landed = () => pane(name).includes(SENTINEL);
    for (let i = 1; i <= 4 && !landed(); i++) {
      client.pushInbound(inFrame(identity.identityId, `s${i}`, prompt));
      const end = Date.now() + 5000;
      while (!landed() && Date.now() < end) await sleep(200);
      console.log(`[subagent] inject ${i}: landed=${landed()}`);
    }

    // The load-bearing proof: a NESTED (assistant_sub / *_sub) frame carrying the sub-agent's codeword
    // reaches the viewer — i.e. agent_progress was captured AND tagged parent_tool_use_id.
    const subHit = () =>
      client.content.some((p) => p.recordKind.endsWith("_sub") && p.text.includes(CODE));
    try {
      await waitFor(subHit, 180_000, "nested sub-agent (_sub) frame with codeword");
      const f = client.content.find((p) => p.recordKind.endsWith("_sub") && p.text.includes(CODE));
      console.log(`[subagent] ✅ NESTED sub-agent frame: kind=${f?.recordKind} text=${JSON.stringify((f?.text ?? "").slice(0, 50))}`);
    } catch (e) {
      console.log("[subagent][diag] content kinds so far:", client.content.map((p) => p.recordKind).join(",") || "(none)");
      console.log("[subagent][diag] any _sub frames:", client.content.filter((p) => p.recordKind.endsWith("_sub")).length);
      console.log("[subagent][diag] pane tail:\n" + pane(`rc-${sid}`).split("\n").filter((l) => l.trim()).slice(-12).join("\n"));
      throw e;
    }
    console.log("[subagent] content kinds:", [...new Set(client.content.map((p) => p.recordKind))].join(","));
  } finally {
    ac.abort();
    await run;
    const alive = await new TmuxCtl().hasSession(`rc-${sid}`);
    console.log("[subagent] tmux alive after teardown:", alive, "(expected false)");
  }
  console.log("[subagent] PASS");
}

main().catch((e) => {
  console.error("[subagent] FAIL:", e);
  process.exit(1);
});
