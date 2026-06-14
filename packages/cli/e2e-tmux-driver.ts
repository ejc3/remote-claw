// Standalone e2e harness for the tmux driver: spawn the REAL claude (2.1.x) in tmux, drive a prompt
// via a FakeClient-style fake broker + onSession, assert the assistant frame round-trips, then
// teardown + confirm the tmux session is killed. NOT part of the unit suite (needs real claude + tmux
// + a logged-in provider) and ignored by biome/tsc (scoped to src/).  Run: pnpm exec tsx e2e-tmux-driver.ts
//
// What this harness PROVED against real claude 2.1.177 (manual + scripted):
//   • env scrub works — the spawned claude is REAL, not a stub (tmux show-environment shows
//     CLAUDE_CODE_CHILD_SESSION is absent, even when the LAUNCHER runs inside a claude session).
//   • spawn → a live TUI in the tmux pane (no MITM / proxy vars).
//   • INJECT: set-buffer → bracketed paste-buffer → Enter lands the prompt in claude's input box and
//     claude replies (e.g. "● PINEAPPLE") — verified repeatedly in the pane.
//   • CAPTURE contract: claude writes ~/.claude/projects/<slug>/<id>.jsonl with an `assistant` line
//     whose message.content is byte-identical to mapUpstreamItems' input (verified file: a real
//     8ba294b5-….jsonl carried `assistant`→"PINEAPPLE").
//   • teardown → tmux kill-session.
// Caveats that make the FULLY-automated loop flaky in this sandbox (NOT driver bugs):
//   • claude's TUI takes ~12-20s to accept paste; a paste before then is dropped (this harness verifies
//     the paste appeared in the pane and re-pushes if not).
//   • claude 2.1.177 in this sandbox writes the transcript JSONL only intermittently for a driven turn
//     (some cwds get only a `memory/` dir), so the assistant-frame assertion can time out even though
//     the inject + reply are visible in the pane. Re-run, or use a project dir where claude persists
//     transcripts. The driver's capture logic is exercised deterministically by the unit suite.

import { execFileSync } from "node:child_process";
import { deriveIdentity, type Frame, type FrameHeader } from "@remote-claw/clawsec";
import type { BrokerClient } from "./src/broker/client.js";
import { runTmuxDriver } from "./src/host/rc/tmux/driver.js";
import { TmuxCtl } from "./src/host/rc/tmux/tmuxctl.js";

const enc = (s: string) => new TextEncoder().encode(s);

interface Posted {
  recordKind: string;
  seq: number | null;
  text: string;
}

class FakeClient {
  posts: Posted[] = [];
  announces: Record<string, unknown>[] = [];
  #inbound: Frame[] = [];
  #wakes = new Set<() => void>();
  get content(): Posted[] {
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
    v: 1,
    identityId: id,
    sessionId: "s",
    dir: "in",
    recordKind,
    seq: null,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    salt: new Uint8Array(32),
    nonce: new Uint8Array(12),
    ct: enc(text),
  } as Frame;
}

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  if (!pred()) throw new Error(`TIMEOUT waiting for ${what}`);
}

async function main() {
  const identity = await deriveIdentity(new Uint8Array(32).fill(7));
  const client = new FakeClient();
  // Use an ALREADY-TRUSTED cwd so claude doesn't show its first-run "trust this folder?" gate (which
  // would block the first turn — a real first-run concern the user handles once per project, not a
  // driver bug). $E2E_TMUX_CWD overrides; default is the trusted repo root.
  const cwd = process.env.E2E_TMUX_CWD ?? "/home/ubuntu/remote-claw";
  const ac = new AbortController();
  let sessionId = "";
  const codeword = "PINEAPPLE";

  console.log("[e2e] spawning REAL claude in tmux (cwd=%s) …", cwd);
  console.log(
    "[e2e] parent env has stub-gotcha:",
    "CHILD=",
    process.env.CLAUDE_CODE_CHILD_SESSION ?? "(unset)",
    "SESSION_ID=",
    process.env.CLAUDE_CODE_SESSION_ID ?? "(unset)",
  );

  const run = runTmuxDriver(
    {
      harnessArgs: [],
      identity,
      brokerUrl: "https://broker.example",
      title: "e2e tmux",
      cwd,
      git: null,
      newClient: () => client as unknown as BrokerClient,
      onSession: (s) => {
        sessionId = s.id;
      },
    },
    ac.signal,
    {},
  );

  try {
    await waitFor(() => sessionId !== "", 5000, "onSession");
    console.log("[e2e] session:", sessionId);
    await waitFor(() => client.announces.length > 0, 5000, "announce");
    console.log("[e2e] announced:", client.announces[0]?.title);

    // Prove the spawned claude is NOT a stub: its tmux pane env must lack CLAUDE_CODE_CHILD_SESSION.
    const tmuxName = `rc-${sessionId}`;
    let paneChild = "(unset — show-environment errored, which means the var is absent)";
    try {
      paneChild = execFileSync(
        "tmux",
        ["show-environment", "-t", tmuxName, "CLAUDE_CODE_CHILD_SESSION"],
        { encoding: "utf8" },
      ).trim();
    } catch {
      // tmux exits non-zero (or prints -CLAUDE_CODE_CHILD_SESSION) when the var is unset — that's the
      // real-not-stub signal we want.
    }
    console.log("[e2e] pane CLAUDE_CODE_CHILD_SESSION:", JSON.stringify(paneChild), "(absent/-prefixed = real, not stub)");

    // Wait for claude's TUI to be interactive before injecting — a prompt pasted before the input box
    // accepts input is dropped. The footer strings appear in the banner within ~1s, well BEFORE the
    // input box is live, so we (a) enforce a minimum boot floor and (b) require the input box to be
    // present on two checks ~2s apart (stable, not mid-render). This is an e2e-harness concern; in
    // real use the human opens the viewer and types after claude has booted.
    console.log("[e2e] waiting for claude's input box to settle …");
    const paneHasInput = () => {
      try {
        const pane = execFileSync("tmux", ["capture-pane", "-t", tmuxName, "-p"], {
          encoding: "utf8",
        });
        return pane.includes("bypass permissions on") && pane.includes("❯");
      } catch {
        return false;
      }
    };
    await new Promise((r) => setTimeout(r, 12_000)); // boot floor (claude needs ~10-15s to be live)
    await waitFor(paneHasInput, 30_000, "input box present");
    await new Promise((r) => setTimeout(r, 3_000));

    // Drive the prompt from the fake viewer. The driver injects as soon as the `user` frame arrives;
    // a paste landing before claude's box is truly live is dropped, so we VERIFY the prompt text shows
    // in the pane and re-push (fresh msgId) until it does — a harness-only readiness retry, not driver
    // logic (in real use the human types after claude has booted).
    const prompt = `Reply with the single word ${codeword} and nothing else.`;
    const pasteLanded = () => {
      try {
        return execFileSync("tmux", ["capture-pane", "-t", tmuxName, "-p"], {
          encoding: "utf8",
        }).includes(prompt);
      } catch {
        return false;
      }
    };
    console.log("[e2e] driving prompt: reply with the single word %s", codeword);
    for (let attempt = 1; attempt <= 4 && !pasteLanded(); attempt++) {
      client.pushInbound(inFrame(identity.identityId, "user", `u${attempt}`, prompt));
      // Wait for the paste to appear in the pane before giving up on this attempt.
      const end = Date.now() + 4000;
      while (!pasteLanded() && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
      console.log(`[e2e] inject attempt ${attempt}: paste landed=${pasteLanded()}`);
    }

    // Wait (generously) for an assistant content frame carrying the codeword.
    try {
      await waitFor(
        () => client.content.some((p) => p.recordKind === "assistant" && p.text.includes(codeword)),
        90_000,
        "assistant frame with codeword",
      );
    } catch (e) {
      // Diagnostics: dump the pane + transcript state so we can see whether inject landed / capture ran.
      try {
        const pane = execFileSync("tmux", ["capture-pane", "-t", tmuxName, "-p"], {
          encoding: "utf8",
        });
        console.log("[e2e][diag] pane on timeout:\n" + pane.split("\n").filter((l) => l.trim()).slice(0, 14).join("\n"));
      } catch {}
      console.log("[e2e][diag] content frames so far:", client.content.map((p) => p.recordKind).join(",") || "(none)");
      throw e;
    }
    const hit = client.content.find((p) => p.recordKind === "assistant" && p.text.includes(codeword));
    console.log("[e2e] ✅ assistant frame:", JSON.stringify(hit?.text));
    console.log("[e2e] total content frames:", client.content.map((p) => p.recordKind).join(","));
  } finally {
    console.log("[e2e] tearing down …");
    ac.abort();
    const code = await run;
    console.log("[e2e] driver exit code:", code);
    const tmux = new TmuxCtl();
    const has = await tmux.hasSession(`rc-${sessionId}`);
    console.log("[e2e] tmux session still alive after teardown:", has, "(expected false)");
    if (has) throw new Error("teardown did NOT kill the tmux session");
  }
  console.log("[e2e] PASS");
}

main().catch((e) => {
  console.error("[e2e] FAIL:", e);
  process.exit(1);
});
