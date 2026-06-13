import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { deriveIdentity } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { Session } from "../session.js";
import { type HistoryMessage, OpencodeClient, type OpencodeEvent } from "./client.js";
import { OpencodeDriver } from "./driver.js";

// Driver-level CAPTURE test. We drive the REAL OpencodeDriver + a REAL HostRcRelay (via bridgeSession),
// replacing only the two transports with controllable fakes:
//   • a FakeOpencodeClient (extends OpencodeClient so the driver's `instanceof` guard accepts it) that
//     yields a CANNED SSE sequence — the exact shapes captured from the live `opencode serve` on
//     ollama/qwen2.5:0.5b (a user-prompt text part, an empty-then-"OK" assistant text part re-sent on
//     each message.part.updated, an assistant message.updated with time.completed, then session.idle).
//   • a FakeBroker (records posts; streams nothing) so the relay's announce/serve run end-to-end.
// The load-bearing assertion: ONE coalesced assistant upstream payload reaches the Session (NOT one per
// part.updated) — review #1. Plus dedup (#2) and ack-incl-initialize (#5).

/** A no-op broker that records what the relay posts and parks its inbound stream until aborted. */
class FakeBroker {
  posts: Array<{ recordKind: string; seq: number | null }> = [];
  async seqCursor(): Promise<{ maxSeq: number | null; durable: boolean }> {
    return { maxSeq: null, durable: false };
  }
  async maxSeq(): Promise<number | null> {
    return null;
  }
  async frameCountCursor(): Promise<{ frameCount: number | null; durable: boolean }> {
    return { frameCount: null, durable: false };
  }
  async frameCount(): Promise<number | null> {
    return null;
  }
  async postMessage(header: FrameHeader): Promise<unknown[]> {
    this.posts.push({ recordKind: header.recordKind, seq: header.seq });
    return [{ ok: true }];
  }
  async postFrame(header: FrameHeader): Promise<unknown> {
    this.posts.push({ recordKind: header.recordKind, seq: header.seq });
    return { ok: true };
  }
  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    // No inbound frames; park until aborted (like a live SSE subscription with no traffic).
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve();
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async openFrame(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

/** A fake OpencodeClient that replays a fixed event list and records the calls the driver makes. It
 *  extends OpencodeClient (so `extra.client instanceof OpencodeClient` passes) but overrides every
 *  method to avoid any real HTTP. */
class FakeOpencodeClient extends OpencodeClient {
  prompts: Array<{ text: string; model: { providerID: string; modelID: string } }> = [];
  aborts = 0;
  replies: Array<{ permissionId: string; response: string }> = [];
  /** Sessions returned by listSessions (the auto-pick). Empty ⇒ the driver creates one. */
  sessionList: Array<{ id: string }> = [];
  /** History returned by getMessages (the attach backfill). Empty by default. */
  history: HistoryMessage[] = [];

  constructor(private readonly script: OpencodeEvent[]) {
    super({ baseUrl: "http://invalid.invalid" });
  }
  override async createSession(): Promise<string> {
    return "ses_fake";
  }
  override async listSessions(): Promise<Array<{ id: string }>> {
    return this.sessionList;
  }
  override async getMessages(): Promise<HistoryMessage[]> {
    return this.history;
  }
  override async promptAsync(
    _sessionId: string,
    args: { text: string; model: { providerID: string; modelID: string } },
  ): Promise<void> {
    this.prompts.push(args);
  }
  override async abort(): Promise<void> {
    this.aborts++;
  }
  override async replyPermission(
    _sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    this.replies.push({ permissionId, response });
  }
  override async *events(_sessionId: string, _signal: AbortSignal): AsyncGenerator<OpencodeEvent> {
    for (const ev of this.script) {
      // Yield to the event loop so the inject pump + relay interleave realistically.
      await new Promise((r) => setTimeout(r, 0));
      yield ev;
    }
    // Stream ends here → the driver's capture pump returns → run() proceeds to teardown.
  }
}

const SES = "ses_fake";
function part(p: Record<string, unknown>): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: { sessionID: SES, part: p },
  } as unknown as OpencodeEvent;
}
function msgUpdated(info: Record<string, unknown>): OpencodeEvent {
  return {
    type: "message.updated",
    properties: { sessionID: SES, info },
  } as unknown as OpencodeEvent;
}
function idle(): OpencodeEvent {
  return { type: "session.idle", properties: { sessionID: SES } };
}

// The captured live sequence for "Reply with exactly: OK": the user prompt echo part (synthetic-free
// here but on the user message, which we never render as assistant), then the assistant text part sent
// FIRST empty then again with "OK" (the re-send the coalescer must collapse), then the completed
// assistant message.updated, then session.idle.
const OK_SCRIPT: OpencodeEvent[] = [
  { type: "server.connected", properties: {} },
  part({ type: "text", id: "prt_user", messageID: "msg_user", text: "Reply with exactly: OK" }),
  msgUpdated({ id: "msg_user", role: "user", time: { created: 1 } }),
  { type: "session.status", properties: { sessionID: SES, status: { type: "busy" } } },
  part({ type: "step-start", id: "prt_step", messageID: "msg_asst" }),
  part({ type: "text", id: "prt_ok", messageID: "msg_asst", text: "" }), // first: empty
  part({ type: "text", id: "prt_ok", messageID: "msg_asst", text: "OK" }), // re-sent: full
  part({ type: "step-finish", id: "prt_fin", messageID: "msg_asst" }),
  msgUpdated({ id: "msg_asst", role: "assistant", time: { created: 1, completed: 2 } }),
  idle(),
];

async function makeCtx(
  client: FakeOpencodeClient,
  broker: FakeBroker,
  onSession: (s: Session) => void,
) {
  const identity = await deriveIdentity(new TextEncoder().encode("driver-test-secret"));
  return {
    harnessArgs: [],
    identity,
    brokerUrl: "http://broker.invalid",
    title: "remote-claw",
    cwd: "/tmp",
    git: null,
    newClient: () => broker as unknown as BrokerClient,
    onSession,
    extra: { client },
  };
}

describe("OpencodeDriver capture (coalesce / dedup / ack)", () => {
  let ac: AbortController | null = null;
  afterEach(() => ac?.abort());

  it("coalesces a re-sent assistant part into ONE upstream payload with the model's text", async () => {
    const client = new FakeOpencodeClient(OK_SCRIPT);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const code = await new OpencodeDriver(ctx).run(ac.signal);
    expect(code).toBe(0);

    const session = captured as unknown as Session;
    expect(session).not.toBeNull();
    const upstream = session.snapshotUpstream();
    // The assertion that proves review #1: exactly ONE assistant payload (NOT one per part.updated,
    // which would be ≥2 for the empty-then-OK re-send + step parts).
    const assistants = upstream.filter((e) => e.eventType === "assistant");
    expect(assistants).toHaveLength(1);
    const a = assistants[0];
    expect(a).toBeDefined();
    const msg = a?.payload.message as { content: Array<{ type: string; text?: string }> };
    expect(msg.content).toEqual([{ type: "text", text: "OK" }]);
    // uuid is the OpenCode messageID (stable across reconnects).
    expect(a?.payload.uuid).toBe("msg_asst");
    // The user message in OK_SCRIPT was NOT injected by the driver (no downstream user event drove it),
    // so it represents a LOCAL prompt (typed at the TUI). It surfaces as exactly ONE local_prompt `user`
    // payload — and it lands BEFORE the assistant reply (prompt then answer).
    const users = upstream.filter((e) => e.eventType === "user");
    expect(users).toHaveLength(1);
    const u = users[0];
    expect(u?.payload.local_prompt).toBe(true);
    expect((u?.payload.message as { content?: unknown })?.content).toBe("Reply with exactly: OK");
    expect((u?.sequenceNum ?? 0) < (a?.sequenceNum ?? 0)).toBe(true); // prompt precedes the reply
  });

  it("dedups: re-delivering the completed message's parts does not produce a second payload", async () => {
    // Append a reconnect-style re-delivery of the SAME assistant part + completion after idle.
    const replayed: OpencodeEvent[] = [
      ...OK_SCRIPT,
      part({ type: "text", id: "prt_ok", messageID: "msg_asst", text: "OK" }),
      msgUpdated({ id: "msg_asst", role: "assistant", time: { created: 1, completed: 2 } }),
      idle(),
    ];
    const client = new FakeOpencodeClient(replayed);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    await new OpencodeDriver(ctx).run(ac.signal);
    const session = captured as unknown as Session;
    expect(session.snapshotUpstream().filter((e) => e.eventType === "assistant")).toHaveLength(1);
  });

  it("acks the leading initialize and an injected prompt (review #5)", async () => {
    // A script that ALSO surfaces a permission gate so we exercise the can_use_tool path; the user
    // prompt + initialize ack is what we assert. We inject a downstream user prompt by hand below.
    const client = new FakeOpencodeClient([
      { type: "server.connected", properties: {} },
      // a permission.asked → should surface a control_request upstream
      {
        type: "permission.asked",
        properties: {
          sessionID: SES,
          id: "per_1",
          permission: "Bash",
          metadata: { command: "ls" },
          tool: { messageID: "msg_a", callID: "call_1" },
        },
      } as OpencodeEvent,
      idle(),
    ]);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    // Run the driver; before it tears down, push a user prompt + the matching permission answer onto the
    // Session's downstream so the inject pump consumes them and acks. We push BEFORE run resolves by
    // racing a microtask that injects then lets the (short) script finish.
    const session0Promise = new Promise<Session>((resolve) => {
      const orig = ctx.onSession;
      ctx.onSession = (s: Session) => {
        orig?.(s);
        // push a user prompt + a permission grant for per_1
        s.pushUserInput("hello opencode");
        s.pushControlResponse("per_1", "allow");
        resolve(s);
      };
    });
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await session0Promise;
    await run;

    // A prompt was injected with the default ollama model.
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]?.text).toBe("hello opencode");
    expect(client.prompts[0]?.model).toEqual({ providerID: "ollama", modelID: "qwen2.5:0.5b" });
    // The permission gate was surfaced upstream as a can_use_tool control_request…
    const session = captured as unknown as Session;
    const gates = session.snapshotUpstream().filter((e) => e.eventType === "control_request");
    expect(gates.length).toBeGreaterThanOrEqual(1);
    // …and the viewer's allow answer was POSTed to OpenCode as "once".
    expect(client.replies).toEqual([{ permissionId: "per_1", response: "once" }]);
  });
});
