// Driver wiring test: drive runTmuxDriver with an injected tmux exec spy + a fake broker client (the
// relay.test.ts FakeClient discipline). Asserts the full bridge:
//   • onSession fires a fresh cse_ and the announce posts the title/cwd.
//   • an appended transcript assistant line round-trips a sealed `assistant` content frame.
//   • a viewer `user` inbound frame drives the fake tmux pane (set-buffer → paste → send Enter).
//   • the child env scrubs the stub-gotcha ids + host secrets but PRESERVES the user's proxy/CA vars
//     (this driver never sets a proxy, so it leaves the user's egress/Bedrock proxy alone).
//   • abort tears down: the tmux session is killed.
// No real tmux, no real claude, no real broker — every side effect is injected.

import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, type Frame, type FrameHeader, type Identity } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import { parseUserSession, runTmuxDriver } from "./driver.js";
import type { TmuxExec, TmuxExecResult } from "./tmuxctl.js";
import { projectSlug, subagentDir } from "./transcript.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const enc = (s: string) => new TextEncoder().encode(s);

interface Posted {
  recordKind: string;
  seq: number | null;
  msgId: string;
  text: string;
}

/** A fake BrokerClient: records posts/announces, serves queued inbound frames (plaintext in `ct`),
 *  reports non-durable so the relay uses the legacy path. Mirrors relay.test.ts's FakeClient. */
class FakeClient {
  posts: Posted[] = [];
  announces: Array<Record<string, unknown>> = [];
  #inbound: Frame[] = [];
  #wakes = new Set<() => void>();

  get content(): Posted[] {
    return this.posts.filter((p) => p.seq !== null);
  }

  async seqCursor(): Promise<{ maxSeq: number | null; durable: boolean }> {
    return { maxSeq: null, durable: false };
  }
  async frameCountCursor(): Promise<{ frameCount: number | null; durable: boolean }> {
    return { frameCount: this.#inbound.length, durable: false };
  }

  pushInbound(f: Frame): void {
    this.#inbound.push(f);
    for (const wake of this.#wakes) wake();
    this.#wakes.clear();
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    this.posts.push({
      recordKind: header.recordKind,
      seq: header.seq,
      msgId: header.msgId,
      text: new TextDecoder().decode(body),
    });
    return [{ ok: true }];
  }
  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    const text = new TextDecoder().decode(body);
    if (header.recordKind === "session_announce") {
      try {
        this.announces.push(JSON.parse(text));
      } catch {
        /* ignore */
      }
    }
    this.posts.push({ recordKind: header.recordKind, seq: header.seq, msgId: header.msgId, text });
    return { ok: true };
  }

  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    let cursor = 0;
    for (;;) {
      while (cursor < this.#inbound.length) {
        const f = this.#inbound[cursor++];
        if (f !== undefined) yield f;
      }
      if (opts.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.#wakes.delete(wake);
          opts.signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.#wakes.add(wake);
        opts.signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  openFrame(frame: Frame): Promise<Uint8Array> {
    return Promise.resolve(frame.ct); // inbound test frames stash plaintext in `ct`
  }
}

/** A `dir:"in"` client frame the relay's inbound pump processes (plaintext stashed in `ct`). */
function inFrame(id: Identity, recordKind: string, msgId: string, text: string): Frame {
  return {
    v: 1,
    identityId: id.identityId,
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

/** A tmux exec spy: records every argv, captures the new-session env + command, returns success. */
function tmuxSpy(): {
  exec: TmuxExec;
  calls: string[][];
  env: () => Record<string, string>;
  command: () => string;
  killed: () => boolean;
} {
  const calls: string[][] = [];
  const exec: TmuxExec = (args): Promise<TmuxExecResult> => {
    calls.push([...args]);
    return Promise.resolve({ code: 0, stdout: args[0] === "-V" ? "tmux 3.4" : "", stderr: "" });
  };
  const newSession = () => calls.find((c) => c[0] === "new-session");
  return {
    exec,
    calls,
    env: () => {
      const e: Record<string, string> = {};
      const ns = newSession() ?? [];
      for (let i = 0; i < ns.length - 1; i++) {
        if (ns[i] === "-e") {
          const kv = ns[i + 1] ?? "";
          const eq = kv.indexOf("=");
          if (eq > 0) e[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
      return e;
    },
    command: () => {
      const ns = newSession() ?? [];
      return ns[ns.length - 1] ?? "";
    },
    killed: () => calls.some((c) => c[0] === "kill-session"),
  };
}

async function makeIdentity(): Promise<Identity> {
  // A deterministic 32-byte secret → a real Identity (the relay seals/headers with it).
  return deriveIdentity(new Uint8Array(32).fill(7));
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  if (!pred()) throw new Error("timed out");
}

describe("runTmuxDriver wiring", () => {
  it("bridges a session: announce, transcript→assistant frame, viewer prompt→pane, scrubbed env, teardown kill", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-driver-cwd-");
    // Pre-create the project DIR (empty) but NOT the transcript file: the driver snapshots existing
    // inodes before spawn and excludes them, so the transcript must be created AFTER the driver is up
    // (a fresh inode) to be discovered — exactly as real claude lazily creates it on the first turn.
    // We append to it below, after waiting for the announce (which happens after the pre-spawn snapshot).
    const home = tmp("rc-driver-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    // The driver PINS --session-id, so the transcript is named by that id. Inject a deterministic id.
    const PINNED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const transcript = join(projDir, `${PINNED}.jsonl`);

    const spy = tmuxSpy();
    const ac = new AbortController();
    let sessionId: string | null = null;

    const run = runTmuxDriver(
      {
        harnessArgs: ["--model", "sonnet"],
        identity,
        brokerUrl: "https://broker.example",
        title: "my session",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
        onSession: (s) => {
          sessionId = s.id;
        },
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        sessionId: PINNED,
        pollMs: 10,
        // A real (clamped) timer, NOT Promise.resolve: the capture + pane-watch loops await this, and a
        // pure-microtask resolve would busy-spin and starve the test's timers / fs I/O / inbound pump.
        // Honor the requested ms (clamped small) so the loops POLL rather than spin — fast but fair.
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        // Inherit an env with the stub-gotcha ids + host secrets (expect SCRUBBED) AND proxy/CA vars
        // (expect PRESERVED — this driver never sets a proxy, so it leaves the user's alone).
        parentEnv: {
          PATH: "/usr/bin",
          CLAUDE_CODE_CHILD_SESSION: "leaked",
          CLAUDE_CODE_SESSION_ID: "parent-id",
          HTTPS_PROXY: "http://127.0.0.1:9",
          NODE_EXTRA_CA_CERTS: "/x/ca.pem",
          VERCEL_AUTOMATION_BYPASS_SECRET: "shhh",
          KEEP_ME: "yes",
        },
      },
    );

    // onSession fires with a fresh cse_ and the announce posts the title.
    await waitFor(() => sessionId !== null);
    expect(sessionId).toMatch(/^cse_[0-9a-f]+$/);
    await waitFor(() => client.announces.length > 0);
    expect(client.announces[0]?.title).toBe("my session");
    expect(client.announces[0]?.cwd).toBe(cwd);

    // The spawned command is plain claude with --dangerously-skip-permissions + forwarded args,
    // prefixed by an `env -u …` scrub that unsets the stub-gotcha ids even if a stale tmux server env
    // holds them (codex review #1).
    expect(spy.command()).toContain("claude");
    expect(spy.command()).toContain("--dangerously-skip-permissions");
    expect(spy.command()).toContain("--model");
    expect(spy.command()).toContain("env");
    expect(spy.command()).toContain("CLAUDE_CODE_CHILD_SESSION");
    // The pinned id is passed as --session-id, so the transcript path is deterministic.
    expect(spy.command()).toContain("--session-id");
    expect(spy.command()).toContain(PINNED);

    // Child env: stub-gotcha ids + host secrets are SCRUBBED; an unrelated var survives; and the user's
    // proxy/CA vars PASS THROUGH (the driver never sets a proxy, so it must not strip the user's).
    const env = spy.env();
    expect(env.KEEP_ME).toBe("yes");
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.VERCEL_AUTOMATION_BYPASS_SECRET).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/x/ca.pem");

    // CAPTURE: append a real-shaped assistant line → a sealed `assistant` content frame is posted.
    await appendFile(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        uuid: "asst-1",
        message: { role: "assistant", content: [{ type: "text", text: "PINEAPPLE" }] },
      })}\n`,
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "assistant"));
    const asst = client.content.find((p) => p.recordKind === "assistant");
    expect(asst?.text).toBe("PINEAPPLE");

    // INJECT: a viewer `user` inbound frame drives the pane (set-buffer → paste-buffer → send Enter).
    client.pushInbound(inFrame(identity, "user", "msg-user-1", "say hi"));
    await waitFor(() => spy.calls.some((c) => c[0] === "send-keys" && c.includes("Enter")));
    const verbs = spy.calls.map((c) => c[0]);
    const sb = verbs.indexOf("set-buffer");
    const pb = verbs.indexOf("paste-buffer");
    const sk = verbs.findIndex(
      (v, i) => v === "send-keys" && (spy.calls[i] ?? []).includes("Enter"),
    );
    expect(sb).toBeGreaterThanOrEqual(0);
    expect(pb).toBeGreaterThan(sb);
    expect(sk).toBeGreaterThan(pb);

    // The relay also ECHOES the viewer prompt as a `user` content frame (so every device sees it).
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));

    // TEARDOWN: abort → the driver flushes + kills the tmux session.
    ac.abort();
    const code = await run;
    expect(code).toBe(0);
    expect(spy.killed()).toBe(true);
  });

  it("local-prompt ledger: suppresses OUR injected prompt's transcript echo, surfaces a LOCALLY-typed one", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-ledger-cwd-");
    const home = tmp("rc-ledger-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    const PINNED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const transcript = join(projDir, `${PINNED}.jsonl`);
    const spy = tmuxSpy();
    const ac = new AbortController();
    const userFrame = (uuid: string, text: string) =>
      `${JSON.stringify({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } })}\n`;
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        sessionId: PINNED,
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
      },
    );
    try {
      await waitFor(() => client.announces.length > 0);
      await writeFile(transcript, ""); // create the pinned file so capture attaches
      // 1) A VIEWER prompt drives the pane → the inject pump records "say hi" in the ledger (onInjected).
      client.pushInbound(inFrame(identity, "user", "msg-1", "say hi"));
      await waitFor(() => spy.calls.some((c) => c[0] === "send-keys" && c.includes("Enter")));
      // The relay echoes the viewer prompt ONCE (its own inbound echo) so every device sees it.
      await waitFor(
        () =>
          client.content.filter((p) => p.recordKind === "user" && p.text.includes("say hi"))
            .length >= 1,
      );
      // 2) claude writes the ECHO of our injected prompt → must be SUPPRESSED (matched in the ledger).
      // 3) A LOCAL prompt typed at the pane (never injected) → SURFACED via local_prompt.
      await appendFile(transcript, userFrame("u-echo", "say hi"));
      await appendFile(transcript, userFrame("u-local", "typed locally"));
      await waitFor(() =>
        client.content.some((p) => p.recordKind === "user" && p.text.includes("typed locally")),
      );
      await new Promise((r) => setTimeout(r, 60)); // give the echo a chance to (wrongly) double
      const sayHi = client.content.filter(
        (p) => p.recordKind === "user" && p.text.includes("say hi"),
      );
      expect(sayHi).toHaveLength(1); // ONLY the relay inbound echo — the transcript echo was suppressed
      const local = client.content.filter(
        (p) => p.recordKind === "user" && p.text.includes("typed locally"),
      );
      expect(local).toHaveLength(1); // the locally-typed prompt surfaced (local_prompt)
    } finally {
      ac.abort();
      await run;
    }
  });

  it("ends the bridge on pane death (sessionGone) with NO external abort, and kills the session", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-driver-pane-");
    const home = tmp("rc-driver-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });

    const calls: string[][] = [];
    let up = false;
    const exec: TmuxExec = (args) => {
      calls.push([...args]);
      if (args[0] === "new-session") up = true;
      // has-session reports the session GONE (exit 1) once the pane has been "started" then closed.
      if (args[0] === "has-session") {
        return Promise.resolve({ code: up ? 1 : 0, stdout: "", stderr: "no session" });
      }
      return Promise.resolve({ code: 0, stdout: args[0] === "-V" ? "tmux 3.4" : "", stderr: "" });
    };

    // No external abort — the pane-liveness probe alone must end the driver.
    const code = await runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      new AbortController().signal,
      {
        tmuxExec: exec,
        home,
        pollMs: 5,
        paneWatchMs: 5,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
      },
    );
    expect(code).toBe(0); // clean pane death (not a pump crash)
    expect(calls.some((c) => c[0] === "kill-session")).toBe(true);
  });

  it("captures a sub-agent file (subagents/agent-*.jsonl) NESTED under its Agent via .meta.json (assistant_sub)", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-driver-sub-cwd-");
    const home = tmp("rc-driver-sub-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    const PINNED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const transcript = join(projDir, `${PINNED}.jsonl`);
    const spy = tmuxSpy();
    const ac = new AbortController();
    let discovered: string | null = null;
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        sessionId: PINNED,
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        onTranscript: (p) => {
          discovered = p;
        },
      },
    );
    try {
      await waitFor(() => client.announces.length > 0);
      // The parent's main transcript: the Agent tool_use that spawns the sub-agent.
      await appendFile(
        transcript,
        `${JSON.stringify({ type: "assistant", uuid: "parent-1", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_AGENT", name: "Agent", input: { description: "review" } }] } })}\n`,
      );
      await waitFor(() => discovered !== null);
      const path = discovered;
      if (path === null) throw new Error("transcript not discovered");
      // The sub-agent's OWN output lives in subagents/agent-<id>.jsonl; the .meta.json links it to the
      // spawning Agent's tool_use_id. Write the meta FIRST (the driver only tails once it's readable).
      const subDir = subagentDir(path);
      await mkdir(subDir, { recursive: true });
      await writeFile(
        join(subDir, "agent-acca.meta.json"),
        JSON.stringify({
          agentType: "general-purpose",
          description: "review",
          toolUseId: "toolu_AGENT",
        }),
      );
      await appendFile(
        join(subDir, "agent-acca.jsonl"),
        `${JSON.stringify({ type: "assistant", uuid: "sub-1", agentId: "acca", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "MANGO from the sub-agent" }] } })}\n`,
      );
      // The sub-agent text reaches the viewer as a NESTED (assistant_sub) frame — not dropped, not flat.
      await waitFor(() =>
        client.content.some((p) => p.recordKind === "assistant_sub" && p.text.includes("MANGO")),
      );
      expect(
        client.content.some((p) => p.recordKind === "assistant_sub" && p.text.includes("MANGO")),
      ).toBe(true);
      // The parent Agent tool_use itself relayed as a TOP-LEVEL tool_use (not _sub).
      expect(client.content.some((p) => p.recordKind === "tool_use")).toBe(true);
    } finally {
      ac.abort();
      await run;
    }
  });

  it("does NOT surface a sub-agent line until its .meta.json link is readable (then nests it)", async () => {
    // The race: the agent-<id>.jsonl can be written (and gain content) a beat BEFORE its .meta.json
    // sidecar. Surfacing a line then would FLAT-FLOOD the main view (no parent_tool_use_id to nest it).
    // The driver must withhold the sub line until readAgentTaskId succeeds — then emit it nested.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-driver-race-cwd-");
    const home = tmp("rc-driver-race-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    const PINNED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const transcript = join(projDir, `${PINNED}.jsonl`);
    const spy = tmuxSpy();
    const ac = new AbortController();
    let discovered: string | null = null;
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        sessionId: PINNED,
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        onTranscript: (p) => {
          discovered = p;
        },
      },
    );
    try {
      await waitFor(() => client.announces.length > 0);
      await appendFile(
        transcript,
        `${JSON.stringify({ type: "assistant", uuid: "parent-r", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_R", name: "Agent", input: { description: "x" } }] } })}\n`,
      );
      await waitFor(() => discovered !== null);
      const path = discovered;
      if (path === null) throw new Error("transcript not discovered");
      const subDir = subagentDir(path);
      await mkdir(subDir, { recursive: true });
      // Write the sub-agent LINE with NO meta yet — it must stay withheld (no frame).
      await appendFile(
        join(subDir, "agent-rr.jsonl"),
        `${JSON.stringify({ type: "assistant", uuid: "sub-r", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "PEAR before meta" }] } })}\n`,
      );
      // Give several poll cycles a chance to (wrongly) surface it; it must NOT appear.
      await new Promise((r) => setTimeout(r, 80));
      expect(client.content.some((p) => p.text.includes("PEAR"))).toBe(false);
      // Now the sidecar lands → the SAME line is surfaced, nested under the Agent.
      await writeFile(
        join(subDir, "agent-rr.meta.json"),
        JSON.stringify({ agentType: "general-purpose", description: "x", toolUseId: "toolu_R" }),
      );
      await waitFor(() =>
        client.content.some((p) => p.recordKind === "assistant_sub" && p.text.includes("PEAR")),
      );
      expect(
        client.content.some((p) => p.recordKind === "assistant_sub" && p.text.includes("PEAR")),
      ).toBe(true);
    } finally {
      ac.abort();
      await run;
    }
  });

  it("--rc-session-hook: injects merged --settings, discovers via the sentinel, and FOLLOWS a rotation", async () => {
    // With the hook on, the command carries a merged `--settings` (preserving the user's) whose
    // SessionStart hook writes to the sentinel. The driver reads the sentinel for the EXACT transcript
    // (no scan) and, when the sentinel reports a NEW transcript (a /clear), follows the rotation.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-hook-cwd-");
    const home = tmp("rc-hook-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    const sentinel = join(tmp("rc-hook-sentinel-"), "hook.ndjson");
    const t1 = join(projDir, "hooksess1.jsonl");
    const t2 = join(projDir, "hooksess2.jsonl");
    const ev = (id: string, path: string, source: string) =>
      `${JSON.stringify({ session_id: id, transcript_path: path, cwd, source })}\n`;
    const asst = (uuid: string, text: string) =>
      `${JSON.stringify({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
    const spy = tmuxSpy();
    const ac = new AbortController();
    let discovered: string | null = null;
    const run = runTmuxDriver(
      {
        harnessArgs: ["--settings", '{"model":"sonnet"}'], // user already passed --settings → must merge
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        injectSessionHook: true,
        sentinelPath: sentinel,
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        onTranscript: (p) => {
          discovered = p;
        },
      },
    );
    try {
      await waitFor(() => client.announces.length > 0);
      // The spawned command carries a single merged --settings that preserves the user's model AND adds
      // our SessionStart hook writing to the sentinel.
      const cmd = spy.command();
      expect(cmd).toContain("--settings");
      expect(cmd).toContain("SessionStart");
      expect(cmd).toContain("sonnet"); // user's --settings preserved
      expect(cmd).toContain("hook.ndjson"); // our sentinel path
      // SessionStart fires → sentinel reports t1. Driver attaches to it (no scan) and relays its lines.
      await writeFile(sentinel, ev("h1", t1, "startup"));
      await appendFile(t1, asst("a1", "FIRST from session one"));
      await waitFor(() => client.content.some((p) => p.text.includes("FIRST from session one")));
      expect(discovered).toBe(t1);
      // A /clear rotates → sentinel reports t2. Driver follows the rotation and relays the new session.
      await appendFile(sentinel, ev("h2", t2, "clear"));
      await appendFile(t2, asst("a2", "SECOND from session two"));
      await waitFor(() => discovered === t2);
      await appendFile(t2, asst("a3", "MORE from session two"));
      await waitFor(() => client.content.some((p) => p.text.includes("MORE from session two")));
      expect(discovered).toBe(t2);
    } finally {
      ac.abort();
      await run;
    }
  });

  it("--rc-session-hook: inserts the merged --settings BEFORE a `--` separator (claude parses it as an option)", async () => {
    // Regression (codex): appending --settings AFTER the user's `--` makes claude treat it as a literal
    // prompt token — the hook never registers AND the JSON pollutes the prompt. It must land in OPTIONS.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-hookdd-cwd-");
    const home = tmp("rc-hookdd-home-");
    const sentinel = join(tmp("rc-hookdd-sent-"), "hook.ndjson");
    const spy = tmuxSpy();
    const ac = new AbortController();
    const run = runTmuxDriver(
      {
        harnessArgs: ["--", "helloprompt"], // a `--` separator with a positional after it
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        injectSessionHook: true,
        sentinelPath: sentinel,
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
      },
    );
    try {
      await waitFor(() => client.announces.length > 0);
      const cmd = spy.command();
      expect(cmd).toContain("--settings");
      expect(cmd).toContain("SessionStart");
      expect(cmd).toContain("helloprompt");
      // --settings lands in the OPTIONS region — BEFORE the `--`-separated positional (the buggy version
      // appended it AFTER, making claude treat it as a literal prompt token and drop the hook).
      expect(cmd.indexOf("--settings")).toBeLessThan(cmd.indexOf("helloprompt"));
    } finally {
      ac.abort();
      await run;
    }
  });

  it("--rc-session-hook: a user --settings we can't parse DISABLES the hook (args passed through, claude errors natively)", async () => {
    // Regression (codex): don't mask claude's own bad-settings error — pass the user's --settings through
    // verbatim and skip hook injection (discovery falls back to the pin).
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-hookbad-cwd-");
    const home = tmp("rc-hookbad-home-");
    const sentinel = join(tmp("rc-hookbad-sent-"), "hook.ndjson");
    const spy = tmuxSpy();
    const ac = new AbortController();
    const run = runTmuxDriver(
      {
        harnessArgs: ["--settings", "/no/such/settings/file.json"], // unparseable (missing file)
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        injectSessionHook: true,
        sentinelPath: sentinel,
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
      },
    );
    try {
      await waitFor(() => client.announces.length > 0);
      const cmd = spy.command();
      expect(cmd).toContain("/no/such/settings/file.json"); // user's --settings passed through unchanged
      expect(cmd).not.toContain("SessionStart"); // no hook injected
      expect(cmd).not.toContain("hook.ndjson"); // no sentinel-based merge
    } finally {
      ac.abort();
      await run;
    }
  });

  it("--rc-session-hook: FALLS BACK to the pinned transcript when the hook never fires (e.g. --bare)", async () => {
    // Verified live: claude --bare skips the hook (sentinel never written) but STILL writes the pinned
    // <uuid>.jsonl. So with the hook enabled, if the sentinel never appears, discovery must fall back to
    // findTranscriptById on the pinned id and still bridge.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-hookfb-cwd-");
    const home = tmp("rc-hookfb-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    const PINNED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const transcript = join(projDir, `${PINNED}.jsonl`);
    const sentinel = join(tmp("rc-hookfb-sent-"), "never-written.ndjson");
    const spy = tmuxSpy();
    const ac = new AbortController();
    let discovered: string | null = null;
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        injectSessionHook: true, // hook ENABLED…
        sentinelPath: sentinel, // …but we NEVER write the sentinel (hook didn't fire)
        sessionId: PINNED, // pin is still passed alongside the hook
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        onTranscript: (p) => {
          discovered = p;
        },
      },
    );
    try {
      await waitFor(() => client.announces.length > 0);
      expect(spy.command()).toContain("--settings"); // hook was injected
      // The pinned transcript appears (the hook never wrote the sentinel) → fallback discovers it.
      await writeFile(
        transcript,
        `${JSON.stringify({ type: "assistant", uuid: "fb1", message: { role: "assistant", content: [{ type: "text", text: "FALLBACK works" }] } })}\n`,
      );
      await waitFor(() => client.content.some((p) => p.text.includes("FALLBACK works")));
      expect(discovered).toBe(transcript); // discovered via the pin, not the (absent) sentinel
    } finally {
      ac.abort();
      await run;
    }
  });

  it("pins --session-id <uuid> and attaches to THAT exact transcript, ignoring a newer sibling", async () => {
    // The driver mints a fresh v4 UUID and spawns `claude --session-id <uuid>`. Discovery then waits
    // for OUR exact `<uuid>.jsonl` (authoritative) — a concurrent same-cwd sibling (a different, even
    // NEWER, transcript) must NOT be mis-attached.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-pin-cwd-");
    const home = tmp("rc-pin-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    const spy = tmuxSpy();
    const ac = new AbortController();
    let discovered: string | null = null;
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        onTranscript: (p) => {
          discovered = p;
        },
      },
    );
    try {
      await waitFor(() => spy.command().includes("--session-id"));
      const uuid = spy.command().match(/--session-id'?\s+'?([0-9a-f-]{36})/)?.[1];
      expect(uuid).toBeDefined();
      // A NEWER sibling (different id) appears first — the pin must make us ignore it.
      await writeFile(join(projDir, "99999999-9999-4999-8999-999999999999.jsonl"), "sibling\n");
      await new Promise((r) => setTimeout(r, 20));
      expect(discovered).toBeNull(); // NOT attached to the sibling
      // Now OUR pinned transcript appears → we attach to exactly it.
      const pinnedPath = join(projDir, `${uuid}.jsonl`);
      await writeFile(pinnedPath, "");
      await waitFor(() => discovered !== null);
      expect(discovered).toBe(pinnedPath);
    } finally {
      ac.abort();
      await run;
    }
  });

  it("throws a clear error when tmux is absent", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const failExec: TmuxExec = () =>
      Promise.resolve({ code: 127, stdout: "", stderr: "tmux: not found" });
    await expect(
      runTmuxDriver(
        {
          harnessArgs: [],
          identity,
          brokerUrl: "https://b",
          title: "t",
          cwd: tmp("rc-driver-notmux-"),
          git: null,
          newClient: () => client as unknown as BrokerClient,
        },
        new AbortController().signal,
        { tmuxExec: failExec, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow(/tmux not found/);
  });
});

describe("parseUserSession — does the user already drive the session, and what id", () => {
  const p = parseUserSession;
  it("no session flags → not owned, no id (we pin)", () => {
    expect(p([])).toEqual({ ownsSession: false, explicitId: null });
    expect(p(["--model", "sonnet"])).toEqual({ ownsSession: false, explicitId: null });
  });
  it("explicit --resume / --session-id (space and = forms) → owned + the id", () => {
    expect(p(["--resume", "abc"])).toEqual({ ownsSession: true, explicitId: "abc" });
    expect(p(["--resume=abc"])).toEqual({ ownsSession: true, explicitId: "abc" });
    expect(p(["--session-id", "xyz"])).toEqual({ ownsSession: true, explicitId: "xyz" });
    expect(p(["--session-id=xyz"])).toEqual({ ownsSession: true, explicitId: "xyz" });
    expect(p(["-r", "abc"])).toEqual({ ownsSession: true, explicitId: "abc" });
  });
  it("a picker (--continue / -c / bare --resume) → owned, id unknown", () => {
    expect(p(["--continue"])).toEqual({ ownsSession: true, explicitId: null });
    expect(p(["-c"])).toEqual({ ownsSession: true, explicitId: null });
    expect(p(["--resume"])).toEqual({ ownsSession: true, explicitId: null }); // no following id
  });
  it("does NOT false-trigger on a flag VALUE that looks like a flag", () => {
    // `--model=-r` is a single token, not the resume flag → not owned.
    expect(p(["--model=-r"])).toEqual({ ownsSession: false, explicitId: null });
    // tokens after `--` are literals, not options → ignored.
    expect(p(["--", "-r", "--resume", "x"])).toEqual({ ownsSession: false, explicitId: null });
  });
});
