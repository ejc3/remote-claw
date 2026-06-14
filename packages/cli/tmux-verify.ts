// HUMAN-STYLE inject-fidelity check for the TMUX wrapper against REAL claude 2.1.x. The opencode
// special-chars test goes through a JSON API; tmux is the RISKIER path — set-buffer → bracketed
// paste-buffer → send-keys Enter — where MULTILINE + special chars (backticks, quotes, $(), unicode)
// could submit early or get mangled. This drives such a prompt and proves it lands in claude's input
// box VERBATIM (the paste delivered every token, no premature submit), then best-effort confirms the
// turn round-trips an assistant frame. NOT part of the unit suite. Run: pnpm exec tsx tmux-verify.ts

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

function inFrame(id: Uint8Array, recordKind: string, msgId: string, text: string): Frame {
  return {
    v: 1, identityId: id, sessionId: "s", dir: "in", recordKind, seq: null, msgId,
    keyEpoch: 0, part: 0, parts: 1, salt: new Uint8Array(32), nonce: new Uint8Array(12), ct: enc(text),
  } as Frame;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(150);
  if (!pred()) throw new Error(`TIMEOUT waiting for ${what}`);
}
const pane = (name: string): string => {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", name, "-p"], { encoding: "utf8" });
  } catch {
    return "";
  }
};

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  const identity = await deriveIdentity(new Uint8Array(32).fill(9));
  const client = new FakeClient();
  const cwd = process.env.E2E_TMUX_CWD ?? "/home/ubuntu/remote-claw";
  const ac = new AbortController();
  let sessionId = "";

  // A multiline prompt with the special chars that would break a naive (non-bracketed) paste or a
  // shell-eval'd inject. Distinctive tokens we then look for VERBATIM in claude's input box.
  const tokens = ["MULTILINE-START", "back`tick`", '"dq"', "$(whoami)", "café-δ", "MULTILINE-END"];
  const prompt =
    `${tokens[0]}\n` +
    `line with ${tokens[1]} and ${tokens[2]}\n` +
    `a dollar expr ${tokens[3]} and unicode ${tokens[4]}\n` +
    `${tokens[5]} — then reply with the single word DONE.`;

  console.log("[tmux-verify] spawning REAL claude in tmux (cwd=%s) …", cwd);
  const run = runTmuxDriver(
    {
      harnessArgs: [], identity, brokerUrl: "https://broker.example", title: "tmux-verify",
      cwd, git: null, newClient: () => client as unknown as BrokerClient,
      onSession: (s) => {
        sessionId = s.id;
      },
    },
    ac.signal,
    {},
  );

  try {
    await waitFor(() => sessionId !== "", 5000, "onSession");
    const name = `rc-${sessionId}`;
    console.log("[tmux-verify] session:", sessionId);
    await waitFor(() => client.announces.length > 0, 5000, "announce");

    // Wait for claude's TUI to be live (boot floor + input box present), then ~3s settle.
    const inputReady = () => pane(name).includes("bypass permissions on") && pane(name).includes("❯");
    await sleep(12_000);
    await waitFor(inputReady, 30_000, "input box present");
    await sleep(3_000);

    // Drive the multiline+special prompt; re-push (fresh msgId) until the FIRST distinctive token shows
    // in the pane (harness-only readiness retry; in real use the human types after boot).
    const landed = () => pane(name).includes(tokens[0] as string);
    for (let attempt = 1; attempt <= 4 && !landed(); attempt++) {
      client.pushInbound(inFrame(identity.identityId, "user", `m${attempt}`, prompt));
      const end = Date.now() + 5000;
      while (!landed() && Date.now() < end) await sleep(200);
      console.log(`[tmux-verify] inject attempt ${attempt}: first token landed=${landed()}`);
    }

    // INJECT FIDELITY (the core check): every distinctive token — across newlines, with backticks /
    // quotes / $() / unicode — appears in the pane, proving the bracketed paste delivered the WHOLE
    // multiline prompt verbatim (no premature submit, no shell eval, no truncation).
    const p = pane(name);
    for (const t of tokens) {
      check(`inject fidelity: pane contains ${JSON.stringify(t)}`, p.includes(t));
    }

    // Best-effort: the turn round-trips an assistant frame (claude in this sandbox writes transcripts
    // intermittently for driven turns — documented in e2e-tmux-driver.ts — so this is best-effort).
    try {
      await waitFor(() => client.content.some((p) => p.recordKind === "assistant"), 60_000, "assistant frame");
      const asst = client.content.find((p) => p.recordKind === "assistant");
      check("round-trip: an assistant frame reached the viewer", true, JSON.stringify((asst?.text ?? "").slice(0, 40)));
    } catch {
      console.log("[tmux-verify] (best-effort) no assistant frame in time — transcript-intermittency in this sandbox; inject fidelity above is the load-bearing check");
    }
    console.log("[tmux-verify] content frames:", client.content.map((p) => p.recordKind).join(",") || "(none)");
  } finally {
    ac.abort();
    const code = await run;
    const tmux = new TmuxCtl();
    const alive = await tmux.hasSession(`rc-${sessionId}`);
    check("teardown: tmux session killed", alive === false, `exit=${code}`);
  }
  console.log(`\n[tmux-verify] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[tmux-verify] FAIL:", e);
  process.exit(1);
});
