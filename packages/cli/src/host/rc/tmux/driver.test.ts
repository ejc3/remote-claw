// Driver wiring test: drive runTmuxDriver with an injected tmux exec spy + a fake broker client (the
// relay.test.ts FakeClient discipline). Asserts the full bridge:
//   • onSession fires a fresh cse_ and the announce posts the title/cwd.
//   • an appended transcript assistant line round-trips a sealed `assistant` content frame.
//   • a viewer `user` inbound frame drives the fake tmux pane (stdin load-buffer → paste → send Enter).
//   • the child env scrubs the stub-gotcha ids + host secrets but PRESERVES the user's proxy/CA vars
//     (this driver never sets a proxy, so it leaves the user's egress/Bedrock proxy alone).
//   • abort tears down: the tmux session is killed.
// No real tmux, no real claude, no real broker — every side effect is injected.

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deriveIdentity, type Frame, type FrameHeader, type Identity } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import { parseUserSession, runTmuxDriver, tmuxCapabilities } from "./driver.js";
import type { TmuxExec, TmuxExecOptions, TmuxExecResult } from "./tmuxctl.js";
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
  #sessionId: string | null = null;

  get content(): Posted[] {
    return this.posts.filter((p) => p.seq !== null);
  }

  get sessionId(): string {
    if (this.#sessionId === null) throw new Error("fake broker session is not bound yet");
    return this.#sessionId;
  }

  get sessionBound(): boolean {
    return this.#sessionId !== null;
  }

  async seqCursor(session: string): Promise<{ maxSeq: number | null; durable: boolean }> {
    this.#sessionId = session;
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

/** A channel-bound `dir:"in"` client frame the relay's inbound pump processes (plaintext in `ct`). */
function inFrame(
  id: Identity,
  client: FakeClient,
  recordKind: string,
  msgId: string,
  text: string,
): Frame {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId: client.sessionId,
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

interface TmuxCall {
  /** Exact argv received by execFile, including a private `-S <socket>` prefix when present. */
  rawArgs: string[];
  /** The tmux verb and its arguments, with the private-socket prefix removed for concise assertions. */
  args: string[];
  options: TmuxExecOptions | undefined;
}

function normalizeTmuxArgs(args: readonly string[]): string[] {
  return args[0] === "-S" && args[1] !== undefined ? [...args.slice(2)] : [...args];
}

/** Simulate the one native behavior a fake tmux process cannot produce on its own: Claude loading the
 * private merged settings and executing its SessionStart hook. The marker path comes from that settings
 * source (not a filename guess), and the native id comes from the driver's pinned launcher argument. */
function simulateReadinessMarker(
  rawArgs: readonly string[],
  nativeSessionIdOverride?: string,
): void {
  const args = normalizeTmuxArgs(rawArgs);
  if (args[0] !== "new-session" || rawArgs[0] !== "-S" || rawArgs[1] === undefined) return;
  const runtimeDir = dirname(rawArgs[1]);
  const settings = JSON.parse(readFileSync(join(runtimeDir, "settings.json"), "utf8")) as {
    hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
  };
  const command = settings.hooks?.SessionStart?.at(-1)?.hooks?.at(-1)?.command;
  const markerPath = command?.match(/>> '([^']+)'$/)?.[1];
  if (markerPath === undefined) throw new Error("fake tmux could not find readiness hook path");

  const launcher = readFileSync(join(runtimeDir, "launch.sh"), "utf8");
  const nativeSessionId =
    nativeSessionIdOverride ??
    launcher.match(/'--session-id'\s+'([^']+)'/)?.[1] ??
    launcher.match(/'(?:--resume|-r)'\s+'([^']+)'/)?.[1] ??
    "fake-native-session";
  appendFileSync(
    markerPath,
    `${JSON.stringify({
      session_id: nativeSessionId,
      transcript_path: join(runtimeDir, `${nativeSessionId}.jsonl`),
      source: "startup",
    })}\n`,
    "utf8",
  );
}

/** A tmux exec spy: retains raw argv/options, exposes normalized verb calls, and reads the private
 * launcher/settings files. Sensitive environment and hook JSON are intentionally absent from argv. */
function tmuxSpy(): {
  exec: TmuxExec;
  calls: string[][];
  rawCalls: TmuxCall[];
  env: () => Record<string, string>;
  command: () => string;
  settings: () => string;
  killed: () => boolean;
  started: () => boolean;
} {
  const calls: string[][] = [];
  const rawCalls: TmuxCall[] = [];
  const exec: TmuxExec = (rawArgs, options): Promise<TmuxExecResult> => {
    const args = normalizeTmuxArgs(rawArgs);
    calls.push(args);
    rawCalls.push({ rawArgs: [...rawArgs], args, options });
    simulateReadinessMarker(rawArgs);
    return Promise.resolve({ code: 0, stdout: args[0] === "-V" ? "tmux 3.4" : "", stderr: "" });
  };
  const newSession = () => rawCalls.find((call) => call.args[0] === "new-session");
  const privateFile = (name: string): string => {
    const call = newSession();
    const socketPath = call?.rawArgs[0] === "-S" ? call.rawArgs[1] : undefined;
    if (socketPath === undefined) return "";
    try {
      return readFileSync(join(dirname(socketPath), name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    exec,
    calls,
    rawCalls,
    // Readiness and announcement happen only after both new-session and a positive has-session proof.
    // `started` deliberately means spawn was attempted, not that the public conversation is ready.
    started: () => calls.some((c) => c[0] === "new-session"),
    env: () => ({ ...(newSession()?.options?.env ?? {}) }),
    command: () => privateFile("launch.sh"),
    settings: () => privateFile("settings.json"),
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
  it("does zero work when the parent signal is already aborted", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const ac = new AbortController();
    ac.abort();
    let execCalls = 0;
    let clientCalls = 0;
    let sessionCalls = 0;
    let runtimeCalls = 0;
    const exec: TmuxExec = () => {
      execCalls += 1;
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await expect(
      runTmuxDriver(
        {
          harnessArgs: [],
          identity,
          brokerUrl: "https://broker.example",
          title: "t",
          cwd: tmp("rc-aborted-cwd-"),
          git: null,
          newClient: () => {
            clientCalls += 1;
            return client as unknown as BrokerClient;
          },
          onSession: () => {
            sessionCalls += 1;
          },
        },
        ac.signal,
        {
          tmuxExec: exec,
          onRuntimeDir: () => {
            runtimeCalls += 1;
          },
        },
      ),
    ).resolves.toBe(0);

    expect(execCalls).toBe(0);
    expect(clientCalls).toBe(0);
    expect(sessionCalls).toBe(0);
    expect(runtimeCalls).toBe(0);
    expect(client.announces).toEqual([]);
  });

  it("does not create a broker client or announce until the native marker and pane probe are both positive", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    let newClientCalls = 0;
    let releaseProbe: ((result: TmuxExecResult) => void) | undefined;
    const probe = new Promise<TmuxExecResult>((resolve) => {
      releaseProbe = resolve;
    });
    const calls: string[][] = [];
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      calls.push(args);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      if (args[0] === "has-session") return probe;
      simulateReadinessMarker(rawArgs);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const ac = new AbortController();
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd: tmp("rc-spawn-gate-cwd-"),
        git: null,
        newClient: () => {
          newClientCalls += 1;
          return client as unknown as BrokerClient;
        },
      },
      ac.signal,
      {
        tmuxExec: exec,
        mirrorPermissions: false,
        parentEnv: { PATH: "/usr/bin", SECRET_NOT_FOR_ARGV: "spawn-secret" },
      },
    );

    await waitFor(() => calls.some((args) => args[0] === "has-session"));
    expect(calls.some((args) => args[0] === "new-session")).toBe(true);
    expect(newClientCalls).toBe(0);
    expect(client.announces).toEqual([]);
    releaseProbe?.({ code: 0, stdout: "", stderr: "" });
    await waitFor(() => client.announces.length === 1);
    expect(newClientCalls).toBe(1);
    ac.abort();
    await expect(run).resolves.toBe(0);
  });

  it("a parent cancellation while the readiness probe is pending cannot publish a late ghost session", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    let newClientCalls = 0;
    let releaseProbe: ((result: TmuxExecResult) => void) | undefined;
    const probe = new Promise<TmuxExecResult>((resolve) => {
      releaseProbe = resolve;
    });
    const calls: string[][] = [];
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      calls.push(args);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      if (args[0] === "has-session") return probe;
      simulateReadinessMarker(rawArgs);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const ac = new AbortController();
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd: tmp("rc-cancel-probe-cwd-"),
        git: null,
        newClient: () => {
          newClientCalls += 1;
          return client as unknown as BrokerClient;
        },
      },
      ac.signal,
      { tmuxExec: exec, mirrorPermissions: false },
    );

    await waitFor(() => calls.some((args) => args[0] === "has-session"));
    ac.abort();
    releaseProbe?.({ code: 0, stdout: "", stderr: "" });

    await expect(run).resolves.toBe(0);
    expect(newClientCalls).toBe(0);
    expect(client.announces).toEqual([]);
    expect(calls.some((args) => args[0] === "kill-session")).toBe(true);
  });

  it("one positive pane probe without a native SessionStart marker never announces", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    let newClientCalls = 0;
    const calls: string[][] = [];
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      calls.push(args);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      if (args[0] === "has-session") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await expect(
      runTmuxDriver(
        {
          harnessArgs: [],
          identity,
          brokerUrl: "https://broker.example",
          title: "t",
          cwd: tmp("rc-unknown-probe-cwd-"),
          git: null,
          newClient: () => {
            newClientCalls += 1;
            return client as unknown as BrokerClient;
          },
        },
        new AbortController().signal,
        {
          tmuxExec: exec,
          mirrorPermissions: false,
          readinessTimeoutMs: 5,
          readinessPollMs: 1,
        },
      ),
    ).rejects.toThrow("did not execute the required SessionStart readiness hook");

    expect(calls.some((args) => args[0] === "new-session")).toBe(true);
    expect(calls.some((args) => args[0] === "has-session")).toBe(true);
    expect(newClientCalls).toBe(0);
    expect(client.announces).toEqual([]);
  });

  it("a short-lived launcher cannot announce after one momentarily positive pane probe", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    let probes = 0;
    let newClientCalls = 0;
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      if (args[0] === "has-session") {
        probes += 1;
        return Promise.resolve({
          code: probes === 1 ? 0 : 1,
          stdout: "",
          stderr: probes === 1 ? "" : "can't find session: short-lived",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await expect(
      runTmuxDriver(
        {
          harnessArgs: [],
          identity,
          brokerUrl: "https://broker.example",
          title: "short lived",
          cwd: tmp("rc-short-lived-cwd-"),
          git: null,
          newClient: () => {
            newClientCalls += 1;
            return client as unknown as BrokerClient;
          },
        },
        new AbortController().signal,
        {
          tmuxExec: exec,
          mirrorPermissions: false,
          readinessTimeoutMs: 100,
          readinessPollMs: 1,
        },
      ),
    ).rejects.toThrow("tmux pane exited before Claude reported native readiness");

    expect(probes).toBe(2);
    expect(newClientCalls).toBe(0);
    expect(client.announces).toEqual([]);
  });

  it("a native marker without a provably live pane never announces", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    let newClientCalls = 0;
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      if (args[0] === "has-session") {
        return Promise.resolve({ code: 127, stdout: "", stderr: "probe unavailable" });
      }
      simulateReadinessMarker(rawArgs);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await expect(
      runTmuxDriver(
        {
          harnessArgs: [],
          identity,
          brokerUrl: "https://broker.example",
          title: "unknown pane",
          cwd: tmp("rc-unknown-probe-cwd-"),
          git: null,
          newClient: () => {
            newClientCalls += 1;
            return client as unknown as BrokerClient;
          },
        },
        new AbortController().signal,
        {
          tmuxExec: exec,
          mirrorPermissions: false,
          readinessTimeoutMs: 5,
          readinessPollMs: 1,
        },
      ),
    ).rejects.toThrow("did not execute the required SessionStart readiness hook");

    expect(newClientCalls).toBe(0);
    expect(client.announces).toEqual([]);
  });

  it("a marker for a different native session cannot satisfy readiness", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    let newClientCalls = 0;
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      simulateReadinessMarker(rawArgs, "wrong-native-session");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await expect(
      runTmuxDriver(
        {
          harnessArgs: [],
          identity,
          brokerUrl: "https://broker.example",
          title: "wrong native id",
          cwd: tmp("rc-wrong-native-id-cwd-"),
          git: null,
          newClient: () => {
            newClientCalls += 1;
            return client as unknown as BrokerClient;
          },
        },
        new AbortController().signal,
        {
          tmuxExec: exec,
          mirrorPermissions: false,
          sessionId: "93939393-9393-4393-8393-939393939393",
        },
      ),
    ).rejects.toThrow("Claude readiness reported an unexpected native session");

    expect(newClientCalls).toBe(0);
    expect(client.announces).toEqual([]);
  });

  it("treats a non-UUID --resume value as picker search and accepts Claude's resolved UUID", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const resolvedId = "12121212-1212-4121-8121-121212121212";
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      simulateReadinessMarker(rawArgs, resolvedId);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const ac = new AbortController();
    const run = runTmuxDriver(
      {
        harnessArgs: ["--resume", "billing migration"],
        identity,
        brokerUrl: "https://broker.example",
        title: "searched resume",
        cwd: tmp("rc-resume-search-cwd-"),
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      { tmuxExec: exec, mirrorPermissions: false },
    );

    await waitFor(() => client.announces.length === 1);
    ac.abort();
    await expect(run).resolves.toBe(0);
  });

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

    const FORWARDED_ARG_SECRET = "FORWARDED_ARG_SECRET_SENTINEL";
    const run = runTmuxDriver(
      {
        harnessArgs: ["--model", "sonnet", "--append-system-prompt", FORWARDED_ARG_SECRET],
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
        // This test validates the OPT-OUT spawn shape (legacy auto-approve). Permission mirroring is the
        // DEFAULT now (B2) — its command shape + the gate/decision round-trip are covered by dedicated
        // tests below; here we keep mirroring OFF to assert the `--dangerously-skip-permissions` command.
        mirrorPermissions: false,
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
    expect(client.announces[0]?.capabilities).toEqual(tmuxCapabilities(false));

    // The spawned command is plain claude with --dangerously-skip-permissions + forwarded args,
    // prefixed by an `env -u …` scrub that unsets the stub-gotcha ids even if a stale tmux server env
    // holds them (codex review #1). Readiness guarantees the private launcher already exists.
    await waitFor(spy.started);
    expect(spy.command()).toContain("claude");
    expect(spy.command()).toContain("--dangerously-skip-permissions");
    expect(spy.command()).toContain("--model");
    expect(spy.command()).toContain(FORWARDED_ARG_SECRET);
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

    // INJECT: a viewer `user` inbound frame drives the pane (stdin load-buffer → paste → send Enter).
    client.pushInbound(inFrame(identity, client, "user", "msg-user-1", "say hi"));
    await waitFor(() => spy.calls.some((c) => c[0] === "send-keys" && c.includes("Enter")));
    const verbs = spy.calls.map((c) => c[0]);
    const sb = verbs.indexOf("load-buffer");
    const pb = verbs.indexOf("paste-buffer");
    const sk = verbs.findIndex(
      (v, i) => v === "send-keys" && (spy.calls[i] ?? []).includes("Enter"),
    );
    expect(sb).toBeGreaterThanOrEqual(0);
    expect(pb).toBeGreaterThan(sb);
    expect(sk).toBeGreaterThan(pb);
    const promptLoad = spy.rawCalls.find(({ args }) => args[0] === "load-buffer");
    expect(promptLoad?.options).toEqual({ stdin: "say hi" });
    expect(JSON.stringify(promptLoad?.rawArgs)).not.toContain("say hi");

    // The relay also ECHOES the viewer prompt as a `user` content frame (so every device sees it).
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));

    // TEARDOWN: abort → the driver flushes + kills the tmux session.
    ac.abort();
    const code = await run;
    expect(code).toBe(0);
    expect(spy.killed()).toBe(true);

    // The binary check is intentionally socket-free; every launch/control/teardown verb shares one
    // per-launch private socket. Environment values stay in exec options, never `-e` or any argv.
    expect(spy.rawCalls[0]?.rawArgs).toEqual(["-V"]);
    const controlledCalls = spy.rawCalls.filter(({ args }) => args[0] !== "-V");
    expect(controlledCalls.length).toBeGreaterThan(0);
    expect(controlledCalls.every(({ rawArgs }) => rawArgs[0] === "-S")).toBe(true);
    expect(new Set(controlledCalls.map(({ rawArgs }) => rawArgs[1])).size).toBe(1);
    expect(controlledCalls[0]?.rawArgs[1]).toMatch(/\/tmux\.sock$/);
    const spawnCall = controlledCalls.find(({ args }) => args[0] === "new-session");
    expect(spawnCall?.rawArgs).not.toContain("-e");
    const rawArgv = JSON.stringify(spy.rawCalls.map(({ rawArgs }) => rawArgs));
    expect(rawArgv).not.toContain("shhh");
    expect(rawArgv).not.toContain("http://127.0.0.1:9");
    expect(rawArgv).not.toContain("/x/ca.pem");
    expect(rawArgv).not.toContain(FORWARDED_ARG_SECRET);
  });

  it("keeps concurrent wrapped sessions isolated by cwd, runtime, socket, target, and paste buffer", async () => {
    const identity = await makeIdentity();
    const clients = [new FakeClient(), new FakeClient()] as const;
    const spies = [tmuxSpy(), tmuxSpy()] as const;
    const controllers = [new AbortController(), new AbortController()] as const;
    const cwd = [tmp("rc-many-a-cwd-"), tmp("rc-many-b-cwd-")] as const;
    const runtime = [tmp("rc-many-a-runtime-"), tmp("rc-many-b-runtime-")] as const;
    const sessionIds: Array<string | null> = [null, null];

    const runs = ([0, 1] as const).map((index) =>
      runTmuxDriver(
        {
          harnessArgs: [],
          identity,
          brokerUrl: "https://broker.example",
          title: `session ${index}`,
          cwd: cwd[index],
          git: null,
          newClient: () => clients[index] as unknown as BrokerClient,
          onSession: (session) => {
            sessionIds[index] = session.id;
          },
        },
        controllers[index].signal,
        {
          tmuxExec: spies[index].exec,
          runtimeDir: runtime[index],
          mirrorPermissions: false,
          pollMs: 10,
          paneWatchMs: 5,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        },
      ),
    );

    try {
      await waitFor(() => clients.every((client) => client.announces.length === 1));
      clients[0].pushInbound(inFrame(identity, clients[0], "user", "many-a", "prompt for A"));
      clients[1].pushInbound(inFrame(identity, clients[1], "user", "many-b", "prompt for B"));
      await waitFor(() =>
        spies.every((spy) =>
          spy.calls.some((call) => call[0] === "send-keys" && call.includes("Enter")),
        ),
      );

      expect(sessionIds[0]).toMatch(/^cse_/);
      expect(sessionIds[1]).toMatch(/^cse_/);
      expect(sessionIds[0]).not.toBe(sessionIds[1]);
      for (const index of [0, 1] as const) {
        const controlled = spies[index].rawCalls.filter(({ args }) => args[0] !== "-V");
        expect(
          controlled.every(({ rawArgs }) => rawArgs[1] === join(runtime[index], "tmux.sock")),
        ).toBe(true);
        const spawn = controlled.find(({ args }) => args[0] === "new-session");
        expect(spawn?.args).toContain(cwd[index]);
        expect(spawn?.args).toContain(`rc-${sessionIds[index]}`);
        const setBuffer = controlled.find(({ args }) => args[0] === "load-buffer");
        expect(setBuffer?.args).toContain(`rcin-${sessionIds[index]}`);
        expect(setBuffer?.options?.stdin).toBe(`prompt for ${index === 0 ? "A" : "B"}`);
        const paste = controlled.find(({ args }) => args[0] === "paste-buffer");
        expect(paste?.args).toContain(`rc-${sessionIds[index]}`);
      }
      expect(join(runtime[0], "tmux.sock")).not.toBe(join(runtime[1], "tmux.sock"));
    } finally {
      controllers[0].abort();
      controllers[1].abort();
      await Promise.all(runs);
    }
  });

  it("creates every wrapper-owned runtime artifact with owner-only permissions", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-private-cwd-");
    const home = tmp("rc-private-home-");
    const runtime = tmp("rc-private-runtime-");
    await chmod(runtime, 0o777);
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const spy = tmuxSpy();
    const ac = new AbortController();
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "private files",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: spy.exec,
        home,
        runtimeDir: runtime,
        sessionId: "91919191-9191-4191-8191-919191919191",
        pollMs: 10,
        paneWatchMs: 5,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        injectSessionHook: true,
      },
    );

    try {
      await waitFor(() => client.announces.length === 1);
      const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
      await expect(mode(runtime)).resolves.toBe(0o700);
      await expect(mode(join(runtime, "launch.sh"))).resolves.toBe(0o700);
      await expect(mode(join(runtime, "settings.json"))).resolves.toBe(0o600);
      await expect(mode(join(runtime, "session-events.ndjson"))).resolves.toBe(0o600);
      await expect(mode(join(runtime, "permission-requests.ndjson"))).resolves.toBe(0o600);
      await expect(mode(join(runtime, "permission-hook.mjs"))).resolves.toBe(0o600);
      await expect(mode(join(runtime, "permission-decisions"))).resolves.toBe(0o700);
    } finally {
      ac.abort();
      await run;
    }
  });

  it("retains an owned private runtime when tmux kill cannot confirm whether the pane survived", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const ac = new AbortController();
    let runtime = "";
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      if (args[0] === "kill-session") {
        return Promise.resolve({ code: 127, stdout: "", stderr: "transport unavailable" });
      }
      simulateReadinessMarker(rawArgs);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "retain uncertain pane",
        cwd: tmp("rc-retain-cwd-"),
        git: null,
        newClient: () => client as unknown as BrokerClient,
      },
      ac.signal,
      {
        tmuxExec: exec,
        mirrorPermissions: false,
        onRuntimeDir: (path) => {
          runtime = path;
          dirs.push(path);
        },
      },
    );

    await waitFor(() => client.announces.length === 1);
    ac.abort();
    await expect(run).resolves.toBe(0);
    expect(runtime).not.toBe("");
    await expect(stat(runtime)).resolves.toBeDefined();
    await expect(readFile(join(runtime, "launch.sh"), "utf8")).resolves.toContain("claude");
  });

  it("prints the retained runtime and private attach command when pre-readiness teardown is uncertain", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    let runtime = "";
    let sessionId = "";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      if (args[0] === "kill-session") {
        return Promise.resolve({ code: 127, stdout: "", stderr: "kill outcome unknown" });
      }
      // Keep the short-lived pane apparently present, but intentionally never write the mandatory
      // SessionStart marker: registration must fail before ready, then uncertain kill retains recovery.
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    try {
      await expect(
        runTmuxDriver(
          {
            harnessArgs: [],
            identity,
            brokerUrl: "https://broker.example",
            title: "pre-ready recovery",
            cwd: tmp("rc-pre-ready-recovery-cwd-"),
            git: null,
            newClient: () => client as unknown as BrokerClient,
            onSession: (session) => {
              sessionId = session.id;
            },
          },
          new AbortController().signal,
          {
            tmuxExec: exec,
            mirrorPermissions: false,
            readinessTimeoutMs: 5,
            readinessPollMs: 1,
            onRuntimeDir: (path) => {
              runtime = path;
              dirs.push(path);
            },
          },
        ),
      ).rejects.toThrow("did not execute the required SessionStart readiness hook");

      const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(runtime).not.toBe("");
      expect(sessionId).toMatch(/^cse_/);
      expect(output).toContain(`retained runtime: ${runtime}`);
      expect(output).toContain(
        `'tmux' '-S' '${join(runtime, "tmux.sock")}' 'attach' '-t' 'rc-${sessionId}'`,
      );
      expect(client.announces).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("permission mirroring (DEFAULT on): spawns WITHOUT --dangerously-skip-permissions, injects the PreToolUse hook, writes the helper + decisions dir", async () => {
    // B2: with mirroring on (the default), the VIEWER is the permission gate — so claude must NOT
    // auto-approve (`--dangerously-skip-permissions` is absent), and a PreToolUse hook is injected via a
    // merged --settings pointing at a helper the driver writes to disk (the helper blocks each tool until
    // the driver writes a decision file in the decisions dir).
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-mirror-cwd-");
    const home = tmp("rc-mirror-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const scratch = tmp("rc-mirror-scratch-");
    const permReqPath = join(scratch, "perm-req.ndjson");
    const permDecDir = join(scratch, "perm-dec");
    const permHelperPath = join(scratch, "perm-hook.mjs");
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        // mirrorPermissions is OMITTED → defaults to ON; we pass the scratch paths so we can assert the
        // helper file + decisions dir the driver creates.
        permReqPath,
        permDecDir,
        permHelperPath,
      },
    );
    try {
      await waitFor(spy.started);
      const cmd = spy.command();
      // Mirroring on → the viewer decides, so claude must NOT skip permissions.
      expect(cmd).not.toContain("--dangerously-skip-permissions");
      // The launcher references a private settings file; hook JSON and paths do not ride in tmux argv.
      expect(cmd).toContain("--settings");
      const settings = spy.settings();
      expect(settings).toContain("PreToolUse");
      expect(settings).toContain("perm-hook.mjs");
      const rawArgv = JSON.stringify(spy.rawCalls.map(({ rawArgs }) => rawArgs));
      expect(rawArgv).not.toContain("PreToolUse");
      expect(rawArgv).not.toContain(permHelperPath);
      await waitFor(() => client.announces.length > 0);
      expect(client.announces[0]?.capabilities).toEqual(tmuxCapabilities(true));
      // The helper script was written to disk (it's the blocking PreToolUse bridge).
      expect(await readFile(permHelperPath, "utf8")).toContain("PreToolUse");
      // The decisions dir was created so the helper has somewhere to poll for its answer.
      expect(await readdir(permDecDir)).toEqual([]);
    } finally {
      ac.abort();
      await run;
    }
  });

  it("mirror ON pre-accepts folder trust for the cwd (so a fresh dir's trust gate can't hang the pane)", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-trustwire-cwd-");
    const home = tmp("rc-trustwire-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const trustCalls: string[] = [];
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        sessionId: "abababab-abab-4bab-8bab-abababababab",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        // mirror defaults ON. Inject a recording trust stub so we assert the wiring without touching any
        // real config file.
        ensureCwdTrusted: (c) => {
          trustCalls.push(c);
          return { changed: true, path: "/stub/.claude.json" };
        },
      },
    );
    try {
      await waitFor(spy.started);
      expect(trustCalls).toEqual([cwd]); // trust seeded for exactly the spawn cwd, before the pane runs
    } finally {
      ac.abort();
      await run;
    }
  });

  it("mirror OFF (--rc-tmux-skip-permissions) does NOT touch folder trust (skip-permissions bypasses it)", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-trustoff-cwd-");
    const home = tmp("rc-trustoff-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const trustCalls: string[] = [];
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        sessionId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        mirrorPermissions: false, // → claude gets --dangerously-skip-permissions, which bypasses trust
        ensureCwdTrusted: (c) => {
          trustCalls.push(c);
          return { changed: false, path: "" };
        },
      },
    );
    try {
      await waitFor(spy.started);
      expect(spy.command()).toContain("--dangerously-skip-permissions");
      expect(trustCalls).toEqual([]); // not called — skip-permissions already trusts the folder
    } finally {
      ac.abort();
      await run;
    }
  });

  it("mirror ON rejects a forwarded --dangerously-skip-permissions before spawn or announce", async () => {
    // Publishing structured permission support while forwarding auto-approve would be a capability lie.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-trustfwd-cwd-");
    const home = tmp("rc-trustfwd-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const trustCalls: string[] = [];
    const spy = tmuxSpy();
    const ac = new AbortController();
    const run = runTmuxDriver(
      {
        harnessArgs: ["--dangerously-skip-permissions"], // user-forwarded; mirror stays ON (default)
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
        sessionId: "efefefef-efef-4fef-8fef-efefefefefef",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        ensureCwdTrusted: (c) => {
          trustCalls.push(c);
          return { changed: true, path: "/stub/.claude.json" };
        },
      },
    );
    await expect(run).rejects.toThrow(/permission mirroring conflicts/);
    expect(spy.started()).toBe(false);
    expect(client.announces).toEqual([]);
    expect(trustCalls).toEqual([]);
  });

  it.each([
    "--bare",
    "--safe-mode",
    "--safe-mode=true",
  ])("rejects hook-disabling argument %s before spawn or announce in every permission mode", async (hookDisablingArg) => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const spy = tmuxSpy();
    let newClientCalls = 0;
    const run = runTmuxDriver(
      {
        harnessArgs: [hookDisablingArg],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd: tmp("rc-hooks-disabled-arg-cwd-"),
        git: null,
        newClient: () => {
          newClientCalls += 1;
          return client as unknown as BrokerClient;
        },
      },
      new AbortController().signal,
      { tmuxExec: spy.exec, mirrorPermissions: false },
    );

    await expect(run).rejects.toThrow(/tmux remote readiness requires Claude hooks/);
    expect(spy.started()).toBe(false);
    expect(newClientCalls).toBe(0);
    expect(client.announces).toEqual([]);
  });

  it.each([
    ["CLAUDE_CODE_SIMPLE", "1"],
    ["CLAUDE_CODE_SIMPLE", "yes"],
    ["CLAUDE_CODE_SAFE_MODE", "true"],
    ["CLAUDE_CODE_SAFE_MODE", "on"],
  ])("rejects truthy hook-disabling environment %s=%s before spawn or announce", async (name, value) => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const spy = tmuxSpy();
    let newClientCalls = 0;
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "t",
        cwd: tmp("rc-hooks-disabled-env-cwd-"),
        git: null,
        newClient: () => {
          newClientCalls += 1;
          return client as unknown as BrokerClient;
        },
      },
      new AbortController().signal,
      {
        tmuxExec: spy.exec,
        mirrorPermissions: false,
        parentEnv: { PATH: "/usr/bin", [name]: value },
      },
    );

    await expect(run).rejects.toThrow(new RegExp(`remove ${name}`));
    expect(spy.started()).toBe(false);
    expect(newClientCalls).toBe(0);
    expect(client.announces).toEqual([]);
  });

  it("CLAUDE_CONFIG_DIR coherence: UNSET in parent → unset for the child (stale tmux-server value can't leak)", async () => {
    // The pane's claude and our trust writer must read the SAME .claude.json. With the var unset in the
    // wrapper env, we `env -u CLAUDE_CONFIG_DIR` so a stale value in a pre-existing tmux server can't make
    // the pane read a different config than the one we seed.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-cfgunset-cwd-");
    const home = tmp("rc-cfgunset-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        parentEnv: { PATH: "/usr/bin" }, // no CLAUDE_CONFIG_DIR
        sessionId: "10101010-1010-4010-8010-101010101010",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        ensureCwdTrusted: () => ({ changed: false, path: "/stub/.claude.json" }),
      },
    );
    try {
      await waitFor(spy.started);
      expect(spy.command()).toContain("CLAUDE_CONFIG_DIR"); // appears only as an `env -u` token
      expect(spy.env().CLAUDE_CONFIG_DIR).toBeUndefined(); // not passed through to the child
    } finally {
      ac.abort();
      await run;
    }
  });

  it("CLAUDE_CONFIG_DIR coherence: SET in parent → passed through to the child, not unset", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-cfgset-cwd-");
    const home = tmp("rc-cfgset-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        parentEnv: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/custom/cfg" },
        sessionId: "20202020-2020-4020-8020-202020202020",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        ensureCwdTrusted: () => ({ changed: false, path: "/stub/.claude.json" }),
      },
    );
    try {
      await waitFor(spy.started);
      expect(spy.env().CLAUDE_CONFIG_DIR).toBe("/custom/cfg"); // exec env makes pane == writer
      expect(spy.command()).not.toContain("CLAUDE_CONFIG_DIR"); // NOT in the `env -u` unset list
    } finally {
      ac.abort();
      await run;
    }
  });

  it("a throwing trust prerequisite fails closed before spawn or announce", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-trustthrow-cwd-");
    const home = tmp("rc-trustthrow-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        sessionId: "30303030-3030-4030-8030-303030303030",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        ensureCwdTrusted: () => {
          throw new Error("EACCES boom");
        },
      },
    );
    await expect(run).rejects.toThrow(/could not prepare Claude folder trust/);
    expect(spy.started()).toBe(false);
    expect(client.announces).toEqual([]);
  });

  it("a bailed trust prerequisite fails closed before spawn or announce", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-trustbail-cwd-");
    const home = tmp("rc-trustbail-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        sessionId: "40404040-4040-4040-8040-404040404040",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        ensureCwdTrusted: () => ({ changed: false, bailed: true, path: "/stub/.claude.json" }),
      },
    );
    await expect(run).rejects.toThrow(/could not safely update Claude folder trust/);
    expect(spy.started()).toBe(false);
    expect(client.announces).toEqual([]);
  });

  it("permission mirroring round-trip: a tool request raises a can_use_tool gate; a viewer allow writes the decision file", async () => {
    // B2 end-to-end (no live claude): the PreToolUse helper would append a tool request to the requests
    // sentinel; here we append it directly. The driver's perm pump must raise a `can_use_tool` gate (the
    // relay posts it as a `permission_request` frame the viewer renders), and when the viewer ALLOWS (an
    // inbound `permission` frame), the inject pump must write `<decisionDir>/<toolUseId>.json` — the file
    // the blocked helper is polling. This proves the full requests→gate→answer→decision-file cycle.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-mirror2-cwd-");
    const home = tmp("rc-mirror2-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const scratch = tmp("rc-mirror2-scratch-");
    const permReqPath = join(scratch, "perm-req.ndjson");
    const permDecDir = join(scratch, "perm-dec");
    const permHelperPath = join(scratch, "perm-hook.mjs");
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        permReqPath,
        permDecDir,
        permHelperPath,
      },
    );
    try {
      await waitFor(spy.started);
      // The PreToolUse hook (simulated) records ONE tool request on the sentinel the driver tails.
      await appendFile(
        permReqPath,
        `${JSON.stringify({
          toolUseId: "tu_gate",
          toolName: "Bash",
          toolInput: { command: "echo hi" },
          sessionId: "s",
          permissionMode: "default",
        })}\n`,
      );
      // The driver raises a can_use_tool gate → the relay posts it as a permission_request frame.
      await waitFor(() =>
        client.content.some(
          (p) => p.recordKind === "permission_request" && p.text.includes("tu_gate"),
        ),
      );
      const gate = client.content.find(
        (p) => p.recordKind === "permission_request" && p.text.includes("tu_gate"),
      );
      if (gate === undefined) throw new Error("permission_request gate not posted");
      const gateBody = JSON.parse(gate.text);
      expect(gateBody.tool_name).toBe("Bash");
      expect(gateBody.request_id).toBe("tu_gate");
      // The viewer ALLOWS → an inbound `permission` frame → the inject pump writes the decision file the
      // blocked helper is polling, keyed by the toolUseId (== request_id).
      client.pushInbound(
        inFrame(
          identity,
          client,
          "permission",
          "msg-perm-1",
          JSON.stringify({ request_id: "tu_gate", behavior: "allow" }),
        ),
      );
      const decFile = join(permDecDir, "tu_gate.json");
      let decision: string | null = null;
      const end = Date.now() + 4000;
      while (decision === null && Date.now() < end) {
        decision = await readFile(decFile, "utf8").catch(() => null);
        if (decision === null) await new Promise((r) => setTimeout(r, 10));
      }
      if (decision === null) throw new Error("decision file never written");
      expect(JSON.parse(decision)).toEqual({ behavior: "allow" });
      expect((await stat(decFile)).mode & 0o777).toBe(0o600);
    } finally {
      ac.abort();
      await run;
    }
  });

  it("a failed permission-decision write fails the driver and leaves that answer unacknowledged", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-perm-write-fail-cwd-");
    const home = tmp("rc-perm-write-fail-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const runtime = tmp("rc-perm-write-fail-runtime-");
    const permReqPath = join(runtime, "permission-requests.ndjson");
    const permDecDir = join(runtime, "permission-decisions");
    const permHelperPath = join(runtime, "permission-hook.mjs");
    const spy = tmuxSpy();
    const exec: TmuxExec = (args, options) => {
      if (normalizeTmuxArgs(args)[0] === "kill-session") {
        // Retain the runtime after the induced pump failure so the failed decision target is inspectable.
        return Promise.resolve({ code: 127, stdout: "", stderr: "kill outcome unknown" });
      }
      return spy.exec(args, options);
    };
    const ac = new AbortController();
    let ackCount = 0;
    const run = runTmuxDriver(
      {
        harnessArgs: [],
        identity,
        brokerUrl: "https://broker.example",
        title: "decision persistence failure",
        cwd,
        git: null,
        newClient: () => client as unknown as BrokerClient,
        onSession: (session) => {
          const originalAck = session.ack.bind(session);
          session.ack = (eventId: string): void => {
            ackCount += 1;
            originalAck(eventId);
          };
        },
      },
      ac.signal,
      {
        tmuxExec: exec,
        home,
        runtimeDir: runtime,
        sessionId: "92929292-9292-4292-8292-929292929292",
        pollMs: 10,
        paneWatchMs: 5,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        permReqPath,
        permDecDir,
        permHelperPath,
      },
    );

    await waitFor(() => client.announces.length === 1);
    await waitFor(() => ackCount >= 1); // the initialize event was successfully handled
    await appendFile(
      permReqPath,
      `${JSON.stringify({
        toolUseId: "tu_write_fail",
        toolName: "Bash",
        toolInput: { command: "echo no" },
        sessionId: "s",
        permissionMode: "default",
      })}\n`,
    );
    await waitFor(() =>
      client.content.some(
        (post) => post.recordKind === "permission_request" && post.text.includes("tu_write_fail"),
      ),
    );
    const ackCountBeforeAnswer = ackCount;
    const finalPath = join(permDecDir, "tu_write_fail.json");
    await mkdir(finalPath);

    client.pushInbound(
      inFrame(
        identity,
        client,
        "permission",
        "msg-perm-write-fail",
        JSON.stringify({ request_id: "tu_write_fail", behavior: "allow" }),
      ),
    );

    await expect(run).resolves.toBe(1);
    expect(ackCount).toBe(ackCountBeforeAnswer);
    expect((await stat(finalPath)).isDirectory()).toBe(true);
  });

  it("AskUserQuestion round-trip (#42): the viewer's answers reach the decision file as updatedInput {questions, answers}", async () => {
    // Full path, no live claude: an AskUserQuestion tool request → the driver raises a can_use_tool gate
    // carrying tool_name=AskUserQuestion + tool_input.questions → the relay STASHES the questions → the
    // viewer answers (an inbound `permission` frame with `answers`) → the relay ECHOES the questions and
    // builds control_response.updatedInput={questions,answers} → the inject pump writes that into the
    // decision file the blocked helper polls. Proves the answers (not just allow/deny) survive the tmux path.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-askq-cwd-");
    const home = tmp("rc-askq-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const scratch = tmp("rc-askq-scratch-");
    const permReqPath = join(scratch, "perm-req.ndjson");
    const permDecDir = join(scratch, "perm-dec");
    const permHelperPath = join(scratch, "perm-hook.mjs");
    const questions = [
      {
        question: "Which name?",
        header: "Name",
        multiSelect: false,
        options: [{ label: "Orion" }],
      },
    ];
    const answers = { "Which name?": "Orion" };
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        sessionId: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        permReqPath,
        permDecDir,
        permHelperPath,
      },
    );
    try {
      await waitFor(spy.started);
      // The (simulated) PreToolUse hook records an AskUserQuestion request carrying the questions.
      await appendFile(
        permReqPath,
        `${JSON.stringify({
          toolUseId: "tu_askq",
          toolName: "AskUserQuestion",
          toolInput: { questions },
          sessionId: "s",
          permissionMode: "default",
        })}\n`,
      );
      await waitFor(() =>
        client.content.some(
          (p) => p.recordKind === "permission_request" && p.text.includes("tu_askq"),
        ),
      );
      // The viewer answers (allow + chosen answers + the tool_use_id, exactly as apps/web sends).
      client.pushInbound(
        inFrame(
          identity,
          client,
          "permission",
          "msg-perm-askq",
          JSON.stringify({
            request_id: "tu_askq",
            behavior: "allow",
            tool_use_id: "tu_askq",
            answers,
          }),
        ),
      );
      const decFile = join(permDecDir, "tu_askq.json");
      let decision: string | null = null;
      const end = Date.now() + 4000;
      while (decision === null && Date.now() < end) {
        decision = await readFile(decFile, "utf8").catch(() => null);
        if (decision === null) await new Promise((r) => setTimeout(r, 10));
      }
      if (decision === null) throw new Error("decision file never written");
      // The relay echoed the stashed questions; the driver wrote {questions, answers} as updatedInput —
      // which the helper re-emits as hookSpecificOutput.updatedInput so claude proceeds with the answers.
      expect(JSON.parse(decision)).toEqual({
        behavior: "allow",
        updatedInput: { questions, answers },
      });
    } finally {
      ac.abort();
      await run;
    }
  });

  it("a NON-AskUserQuestion gate answered with stray answers does NOT write updatedInput (#147 guard)", async () => {
    // Defense-in-depth: even if a client posts `answers` on a Bash gate, the driver must NOT carry it into
    // the decision file (only AskUserQuestion gates do), so Bash's real input can never be clobbered.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-bashguard-cwd-");
    const home = tmp("rc-bashguard-home-");
    await mkdir(join(home, ".claude", "projects", projectSlug(cwd)), { recursive: true });
    const scratch = tmp("rc-bashguard-scratch-");
    const permReqPath = join(scratch, "perm-req.ndjson");
    const permDecDir = join(scratch, "perm-dec");
    const permHelperPath = join(scratch, "perm-hook.mjs");
    const spy = tmuxSpy();
    const ac = new AbortController();
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
        sessionId: "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0",
        pollMs: 10,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : Math.min(ms, 5))),
        paneWatchMs: 5,
        permReqPath,
        permDecDir,
        permHelperPath,
      },
    );
    try {
      await waitFor(spy.started);
      await appendFile(
        permReqPath,
        `${JSON.stringify({
          toolUseId: "tu_bash",
          toolName: "Bash",
          toolInput: { command: "ls" },
          sessionId: "s",
          permissionMode: "default",
        })}\n`,
      );
      await waitFor(() =>
        client.content.some(
          (p) => p.recordKind === "permission_request" && p.text.includes("tu_bash"),
        ),
      );
      // A client posts allow + stray answers for the Bash gate (the relay forwards them as updatedInput).
      client.pushInbound(
        inFrame(
          identity,
          client,
          "permission",
          "msg-perm-bash",
          JSON.stringify({ request_id: "tu_bash", behavior: "allow", answers: { hijack: "x" } }),
        ),
      );
      const decFile = join(permDecDir, "tu_bash.json");
      let decision: string | null = null;
      const end = Date.now() + 4000;
      while (decision === null && Date.now() < end) {
        decision = await readFile(decFile, "utf8").catch(() => null);
        if (decision === null) await new Promise((r) => setTimeout(r, 10));
      }
      if (decision === null) throw new Error("decision file never written");
      // Allowed, but NO updatedInput — the Bash gate isn't AskUserQuestion, so the answers are dropped.
      expect(JSON.parse(decision)).toEqual({ behavior: "allow" });
    } finally {
      ac.abort();
      await run;
    }
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
      await waitFor(spy.started);
      await waitFor(() => client.sessionBound);
      await writeFile(transcript, ""); // create the pinned file so capture attaches
      // 1) A VIEWER prompt drives the pane → the inject pump records "say hi" in the ledger (onInjected).
      client.pushInbound(inFrame(identity, client, "user", "msg-1", "say hi"));
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

      // 4) TRIM robustness: an injected prompt whose transcript echo has trailing whitespace still matches
      // (ledger keys are trimmed) → suppressed, not double-shown.
      client.pushInbound(inFrame(identity, client, "user", "msg-2", "trim me"));
      await waitFor(
        () => spy.calls.filter((c) => c[0] === "send-keys" && c.includes("Enter")).length >= 2,
      );
      await waitFor(() =>
        client.content.some((p) => p.recordKind === "user" && p.text.includes("trim me")),
      );
      await appendFile(transcript, userFrame("u-trim", "trim me  \n")); // echo with trailing whitespace
      await new Promise((r) => setTimeout(r, 60));
      const trimmed = client.content.filter(
        (p) => p.recordKind === "user" && p.text.includes("trim me"),
      );
      expect(trimmed).toHaveLength(1); // trailing-whitespace echo trim-matched → suppressed (no double)
    } finally {
      ac.abort();
      await run;
    }
  });

  it("local-prompt ledger: a nested (parent_tool_use_id) user line and a whitespace-only line are NOT surfaced", async () => {
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-ledger2-cwd-");
    const home = tmp("rc-ledger2-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    const PINNED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const transcript = join(projDir, `${PINNED}.jsonl`);
    const spy = tmuxSpy();
    const ac = new AbortController();
    const line = (extra: Record<string, unknown>): string =>
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: String(extra.text ?? "") }] }, ...extra })}\n`;
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
      await waitFor(spy.started);
      await writeFile(transcript, "");
      // A MAIN-file user line already carrying parentToolUseID (renamed → parent_tool_use_id) is a nested
      // turn, NOT a typed prompt — it must be excluded from the ledger (gated on the payload field, not the
      // tailer arg). A whitespace-only line trims to "" and must be skipped (no empty bubble). A normal
      // local prompt is the positive control: it MUST surface.
      await appendFile(
        transcript,
        line({ uuid: "u-nested", text: "nested turn", parentToolUseID: "task_77" }),
      );
      await appendFile(transcript, line({ uuid: "u-blank", text: "   " }));
      await appendFile(transcript, line({ uuid: "u-real", text: "real local prompt" }));
      await waitFor(() =>
        client.content.some((p) => p.recordKind === "user" && p.text.includes("real local prompt")),
      );
      await new Promise((r) => setTimeout(r, 60)); // let any (wrongly) surfaced lines flush
      const surfaced = client.content.filter((p) => p.recordKind === "user");
      expect(surfaced.some((p) => p.text.includes("real local prompt"))).toBe(true); // control surfaced
      expect(surfaced.some((p) => p.text.includes("nested turn"))).toBe(false); // nested → not local_prompt
      expect(surfaced.some((p) => p.text.trim() === "")).toBe(false); // whitespace-only → no empty bubble
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
    let probes = 0;
    const exec: TmuxExec = (rawArgs) => {
      const args = normalizeTmuxArgs(rawArgs);
      calls.push(args);
      // The readiness probe is positive; subsequent watcher probes report a confirmed pane death.
      if (args[0] === "has-session") {
        probes += 1;
        return Promise.resolve({
          code: probes === 1 ? 0 : 1,
          stdout: "",
          stderr: probes === 1 ? "" : "can't find session: rc-dead",
        });
      }
      simulateReadinessMarker(rawArgs);
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
      await waitFor(spy.started);
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
      await waitFor(spy.started);
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
      await waitFor(spy.started);
      await waitFor(() => client.announces.length === 1);
      // The launcher carries only the private --settings path. The file preserves the user's model and
      // adds our SessionStart hook without placing either JSON or the sentinel path in tmux argv.
      const cmd = spy.command();
      expect(cmd).toContain("--settings");
      const settings = spy.settings();
      expect(settings).toContain("SessionStart");
      expect(settings).toContain("sonnet"); // user's --settings preserved
      expect(settings).toContain("hook.ndjson"); // our sentinel path
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
      await waitFor(spy.started);
      const cmd = spy.command();
      expect(cmd).toContain("--settings");
      expect(spy.settings()).toContain("SessionStart");
      expect(cmd).toContain("helloprompt");
      // --settings lands in the OPTIONS region — BEFORE the `--`-separated positional (the buggy version
      // appended it AFTER, making claude treat it as a literal prompt token and drop the hook).
      expect(cmd.indexOf("--settings")).toBeLessThan(cmd.indexOf("helloprompt"));
    } finally {
      ac.abort();
      await run;
    }
  });

  it("unreadable user --settings fails closed when it cannot carry the native-readiness hook", async () => {
    // Native readiness is required in every permission mode. An unmergeable settings input must not
    // silently launch without the SessionStart proof and publish a writable remote conversation.
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
    await expect(run).rejects.toThrow(/could not merge the required tmux readiness hook/);
    expect(spy.started()).toBe(false);
    expect(client.announces).toEqual([]);
  });

  it("capture falls back to the pinned transcript when optional rotation-follow is disabled", async () => {
    // The always-on SessionStart marker proves native readiness. When optional rotation-follow is off,
    // capture remains independent and safely locates the exact transcript through the driver's pinned id.
    const identity = await makeIdentity();
    const client = new FakeClient();
    const cwd = tmp("rc-hookfb-cwd-");
    const home = tmp("rc-hookfb-home-");
    const projDir = join(home, ".claude", "projects", projectSlug(cwd));
    await mkdir(projDir, { recursive: true });
    const PINNED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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
        injectSessionHook: false,
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
      await waitFor(spy.started);
      expect(spy.command()).toContain("--settings"); // the readiness hook is always injected
      // The pinned transcript appears → capture finds it without consuming the readiness marker.
      await writeFile(
        transcript,
        `${JSON.stringify({ type: "assistant", uuid: "fb1", message: { role: "assistant", content: [{ type: "text", text: "FALLBACK works" }] } })}\n`,
      );
      await waitFor(() => client.content.some((p) => p.text.includes("FALLBACK works")));
      expect(discovered).toBe(transcript);
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

describe("tmuxCapabilities — mirroring flips structuredPermissions", () => {
  it("mirroring ON → structuredPermissions true (the viewer is the gate)", () => {
    expect(tmuxCapabilities(true).structuredPermissions).toBe(true);
  });
  it("mirroring OFF → structuredPermissions false (claude auto-approves)", () => {
    expect(tmuxCapabilities(false).structuredPermissions).toBe(false);
  });
  it("controls: interrupt+setModel honored (ESC / `/model` inject); setMode+end have no pane analogue", () => {
    for (const mirror of [true, false]) {
      const c = tmuxCapabilities(mirror).controls;
      expect(c.interrupt).toBe(true);
      expect(c.setModel).toBe(true);
      expect(c.setMode).toBe(false);
      expect(c.end).toBe(false);
    }
  });
});

describe("parseUserSession — does the user already drive the session, and what id", () => {
  const p = parseUserSession;
  const UUID = "11111111-1111-4111-8111-111111111111";
  it("no session flags → not owned, no id (we pin)", () => {
    expect(p([])).toEqual({ ownsSession: false, explicitId: null });
    expect(p(["--model", "sonnet"])).toEqual({ ownsSession: false, explicitId: null });
  });
  it("explicit UUID --resume / --session-id (space and = forms) → owned + the id", () => {
    expect(p(["--resume", UUID])).toEqual({ ownsSession: true, explicitId: UUID });
    expect(p([`--resume=${UUID}`])).toEqual({ ownsSession: true, explicitId: UUID });
    expect(p(["--session-id", "xyz"])).toEqual({ ownsSession: true, explicitId: "xyz" });
    expect(p(["--session-id=xyz"])).toEqual({ ownsSession: true, explicitId: "xyz" });
    expect(p(["-r", UUID])).toEqual({ ownsSession: true, explicitId: UUID });
  });
  it("a picker or resume search term → owned, id unknown", () => {
    expect(p(["--continue"])).toEqual({ ownsSession: true, explicitId: null });
    expect(p(["-c"])).toEqual({ ownsSession: true, explicitId: null });
    expect(p(["--resume"])).toEqual({ ownsSession: true, explicitId: null }); // no following id
    expect(p(["--resume", "billing migration"])).toEqual({
      ownsSession: true,
      explicitId: null,
    });
    expect(p(["--resume=billing"])).toEqual({ ownsSession: true, explicitId: null });
    expect(p(["-r", "billing"])).toEqual({ ownsSession: true, explicitId: null });
  });
  it("does NOT false-trigger on a flag VALUE that looks like a flag", () => {
    // `--model=-r` is a single token, not the resume flag → not owned.
    expect(p(["--model=-r"])).toEqual({ ownsSession: false, explicitId: null });
    // tokens after `--` are literals, not options → ignored.
    expect(p(["--", "-r", "--resume", "x"])).toEqual({ ownsSession: false, explicitId: null });
  });
});
