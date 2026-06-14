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
import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, type Frame, type FrameHeader, type Identity } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import { runTmuxDriver } from "./driver.js";
import type { TmuxExec, TmuxExecResult } from "./tmuxctl.js";
import { projectSlug } from "./transcript.js";

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
    const transcript = join(projDir, "sess.jsonl");

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
