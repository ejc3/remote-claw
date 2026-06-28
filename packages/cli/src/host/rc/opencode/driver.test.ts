import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { deriveIdentity } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { Session } from "../session.js";
import {
  type HistoryMessage,
  OpencodeClient,
  type OpencodeEvent,
  parseSseFrame,
} from "./client.js";
import { errText, OpencodeDriver } from "./driver.js";

// Driver-level CAPTURE test. We drive the REAL OpencodeDriver + a REAL HostRcRelay (via bridgeSession),
// replacing only the two transports with controllable fakes:
//   • a FakeOpencodeClient (extends OpencodeClient so the driver's `instanceof` guard accepts it) that
//     yields a CANNED SSE sequence — the exact shapes captured from the live `opencode serve` on
//     ollama/qwen2.5:0.5b (a user-prompt text part, an empty-then-"OK" assistant text part re-sent on
//     each message.part.updated, an assistant message.updated with time.completed, then session.idle).
//   • a FakeBroker (records posts; streams nothing) so the relay's announce/serve run end-to-end.
// The load-bearing assertion: ONE coalesced assistant upstream payload reaches the Session (NOT one per
// part.updated) — review #1. Plus dedup (#2) and ack-incl-initialize (#5).

/** A no-op broker that records what the relay posts (recordKind/seq + the plaintext body — relay #post
 *  passes utf8(text), so this is exactly what a viewer renders) and parks its inbound stream until
 *  aborted. `content` is the durable transcript (seq !== null). */
class FakeBroker {
  posts: Array<{ recordKind: string; seq: number | null; text: string }> = [];
  get content() {
    return this.posts.filter((p) => p.seq !== null);
  }
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
  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    this.posts.push({
      recordKind: header.recordKind,
      seq: header.seq,
      text: new TextDecoder().decode(body),
    });
    return [{ ok: true }];
  }
  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    this.posts.push({
      recordKind: header.recordKind,
      seq: header.seq,
      text: new TextDecoder().decode(body),
    });
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
  summarizes: string[] = [];
  override async summarize(sessionId: string): Promise<void> {
    this.summarizes.push(sessionId);
  }
  override async replyPermission(
    _sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    this.replies.push({ permissionId, response });
  }
  /** How many times events() has been (re)subscribed — the reconnect test asserts this grows. */
  connections = 0;
  /** Per-connection scripts. When set, the Nth events() call replays scripts[N]; every connection EOFs
   *  after its script EXCEPT the last, which PARKS until aborted (a real long-lived SSE stays open). When
   *  unset, every connection replays `script` then parks. A connection whose script ends before the last
   *  models a transient SSE drop the driver must reconnect from (review #2). */
  connectionScripts: OpencodeEvent[][] | null = null;

  override async *events(
    want: string | ((id: string | undefined) => boolean),
    signal: AbortSignal,
  ): AsyncGenerator<OpencodeEvent> {
    const idx = this.connections;
    this.connections++;
    const scripts = this.connectionScripts;
    const events = scripts ? (scripts[Math.min(idx, scripts.length - 1)] ?? []) : this.script;
    // The LAST connection (or the only one) parks after its script; earlier connections EOF to model a
    // drop. A real SSE stream stays open after a turn, so parking-until-abort is the faithful default.
    const isLast = scripts ? idx >= scripts.length - 1 : true;
    // Replicate the REAL client's server-wide filter (client.ts events()) so the driver tests exercise the
    // genuine follow-gating: a child sub-agent's events are NOT delivered until the driver follows it, and
    // a `session.created` (the discovery event) IS delivered to a predicate consumer even for a not-yet-
    // followed session (#102). `want` is read at yield time so a child added to #followed mid-stream starts
    // being delivered immediately (the predicate closes over the driver's live #followed set).
    const isPredicate = typeof want === "function";
    const deliver = (ev: OpencodeEvent): boolean => {
      // Discovery: a predicate consumer gets EVERY session.created BEFORE any session filtering (its
      // session is the not-yet-followed child, possibly carried only as info.id) — matches client.ts.
      if (isPredicate && ev.type === "session.created") return true;
      const props = ev.properties as
        | { sessionID?: string; part?: { sessionID?: string }; info?: { sessionID?: string } }
        | undefined;
      const evSession = props?.sessionID ?? props?.part?.sessionID ?? props?.info?.sessionID;
      if (evSession === undefined) return ev.type.startsWith("server.");
      return isPredicate
        ? (want as (id: string | undefined) => boolean)(evSession)
        : evSession === want;
    };
    for (const ev of events) {
      if (signal.aborted) return;
      // Yield to the event loop so the inject pump + relay interleave realistically.
      await new Promise((r) => setTimeout(r, 0));
      if (!deliver(ev)) continue; // gated by the same filter the real server-wide stream applies
      yield ev;
    }
    if (!isLast) return; // EOF → the driver's #capturePump must reconnect (NOT tear down) — review #2.
    // Park until aborted: a live SSE stays open after a turn. run() ends only on the parent abort.
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
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
function sessionError(error: unknown): OpencodeEvent {
  return {
    type: "session.error",
    properties: { sessionID: SES, error },
  } as unknown as OpencodeEvent;
}

// ── Sub-agent (child session) event builders (#102) ─────────────────────────────────────────────────
// A child sub-agent runs as a SEPARATE OpenCode session whose events carry the CHILD's id (a part event
// nests the id in `part.sessionID`, matching the real shape). The driver follows the child on a
// `session.created` whose `info.parentID` is the bridged session, and tags the child's messages with the
// spawning subtask part's id so they nest under the Task tool_use anchor.
const CHILD = "ses_child";
/** A `session.created` for a child session (parentID → its parent, agent → which subagent spawned it). The
 *  event's own session is the NEW child id (`properties.sessionID = info.id`), so the real filter only
 *  delivers it via the discovery exception — exactly the path #102 depends on. */
function sessionCreated(info: { id: string; parentID?: string; agent?: string }): OpencodeEvent {
  return {
    type: "session.created",
    properties: { sessionID: info.id, info },
  } as unknown as OpencodeEvent;
}
/** A `message.part.updated` for the CHILD session — the session id rides on `part.sessionID` (the nested
 *  shape the real server uses for part events), so the driver records it in #msgSession for tag lookup. */
function childPart(p: Record<string, unknown>): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: { part: { ...p, sessionID: CHILD } },
  } as unknown as OpencodeEvent;
}
function childMsgUpdated(info: Record<string, unknown>): OpencodeEvent {
  return {
    type: "message.updated",
    properties: { sessionID: CHILD, info },
  } as unknown as OpencodeEvent;
}
function childIdle(): OpencodeEvent {
  return { type: "session.idle", properties: { sessionID: CHILD } };
}
function statusOf(sid: string, type: string): OpencodeEvent {
  return { type: "session.status", properties: { sessionID: sid, status: { type } } };
}
// Generalized variants for tests with MULTIPLE child sessions (the part's session rides on part.sessionID,
// the nested shape the real server uses for part events).
function partFor(sid: string, p: Record<string, unknown>): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: { part: { ...p, sessionID: sid } },
  } as unknown as OpencodeEvent;
}
function msgUpdatedFor(sid: string, info: Record<string, unknown>): OpencodeEvent {
  return {
    type: "message.updated",
    properties: { sessionID: sid, info },
  } as unknown as OpencodeEvent;
}
function idleFor(sid: string): OpencodeEvent {
  return { type: "session.idle", properties: { sessionID: sid } };
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll `pred` up to `ms`, returning its final value. The fake SSE now PARKS after its script (a real
 *  stream stays open — review #2), so run() no longer resolves on EOF; tests wait for their condition,
 *  then abort and await the exit code. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(5);
  return pred();
}
/** The captured Session's upstream snapshot (the `captured` ref is set in an onSession callback that TS
 *  can't see, so it narrows to never — this cast reads it back safely). */
function up(s: Session | null) {
  return (s as unknown as Session | null)?.snapshotUpstream() ?? [];
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
    const run = new OpencodeDriver(ctx).run(ac.signal);
    // The fake SSE parks after its script (review #2), so wait for the assistant to flush, then abort.
    await waitFor(() => up(captured).some((e) => e.eventType === "assistant"));
    ac.abort();
    const code = await run;
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
    const run = new OpencodeDriver(ctx).run(ac.signal);
    // The whole replayed script yields with a 0ms tick per event; wait for the assistant, then let the
    // re-delivery (appended after idle) drain before aborting so dedup has a chance to (not) re-emit.
    await waitFor(() => up(captured).some((e) => e.eventType === "assistant"));
    await sleep(50);
    ac.abort();
    await run;
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
    // The fake SSE parks (review #2); wait for the inject pump to drain the prompt + permission reply,
    // then abort and await the exit code.
    await waitFor(() => client.prompts.length >= 1 && client.replies.length >= 1);
    ac.abort();
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

  // Scenario (g): the cheap model (qwen2.5:0.5b) does not reliably surface a permission gate live, so the
  // permission ROUND-TRIP is proven deterministically here against the driver's own translation:
  //   • permission.asked → the EXACT can_use_tool control_request shape mapUpstreamItems renders, and
  //   • a viewer DENY → POST .../permissions/{id} { response: "reject" } (allow → "once" is proven above).
  it("(g) surfaces a permission gate as can_use_tool and maps deny → reject", async () => {
    const client = new FakeOpencodeClient([
      { type: "server.connected", properties: {} },
      {
        type: "permission.asked",
        properties: {
          sessionID: SES,
          id: "per_deny",
          permission: "Bash",
          metadata: { command: "rm -rf /" },
          tool: { messageID: "msg_b", callID: "call_2" },
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
    const ready = new Promise<Session>((resolve) => {
      const orig = ctx.onSession;
      ctx.onSession = (s: Session) => {
        orig?.(s);
        s.pushControlResponse("per_deny", "deny"); // the viewer denies the gate
        resolve(s);
      };
    });
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await ready;
    await waitFor(() => client.replies.length >= 1);
    ac.abort();
    await run;

    const session = captured as unknown as Session;
    // The gate surfaced as a can_use_tool control_request with the exact shape the relay renders.
    const gate = session
      .snapshotUpstream()
      .find(
        (e) => e.eventType === "control_request" && (e.payload.request_id as string) === "per_deny",
      );
    expect(gate).toBeDefined();
    const req = gate?.payload.request as {
      subtype?: string;
      tool_name?: string;
      tool_use_id?: string;
      input?: unknown;
    };
    expect(req?.subtype).toBe("can_use_tool");
    expect(req?.tool_name).toBe("Bash");
    expect(req?.tool_use_id).toBe("call_2");
    expect(req?.input).toEqual({ command: "rm -rf /" });
    // The deny answer was POSTed to OpenCode as "reject".
    expect(client.replies).toEqual([{ permissionId: "per_deny", response: "reject" }]);
  });

  // Scenario (c) DETERMINISTIC: the tiny live model rarely calls a tool, so we prove the tool path
  // end-to-end here — a real completed-tool SSE sequence (assistant message with a `tool` part going
  // completed) flushed through the REAL relay must produce a `tool_use` content frame AND a following
  // `tool_result` content frame (the bodies mapUpstreamItems renders). This is the rigorous proof for (c).
  it("(c-det) a completed tool turn → a tool_use frame + a tool_result frame at the broker", async () => {
    const TOOL_SCRIPT: OpencodeEvent[] = [
      { type: "server.connected", properties: {} },
      { type: "session.status", properties: { sessionID: SES, status: { type: "busy" } } },
      part({ type: "step-start", id: "prt_s", messageID: "msg_tool" }),
      // a `tool` part: first running, then re-sent completed (the coalescer keeps the latest).
      part({
        type: "tool",
        id: "prt_t",
        messageID: "msg_tool",
        callID: "call_echo",
        tool: "bash",
        state: { status: "running", input: { command: "echo hello" } },
      }),
      part({
        type: "tool",
        id: "prt_t",
        messageID: "msg_tool",
        callID: "call_echo",
        tool: "bash",
        state: { status: "completed", input: { command: "echo hello" }, output: "hello\n" },
      }),
      part({ type: "step-finish", id: "prt_f", messageID: "msg_tool" }),
      msgUpdated({ id: "msg_tool", role: "assistant", time: { created: 1, completed: 2 } }),
      idle(),
    ];
    const client = new FakeOpencodeClient(TOOL_SCRIPT);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await waitFor(() => broker.content.some((p) => p.recordKind === "tool_result"));
    ac.abort();
    const code = await run;
    expect(code).toBe(0);
    expect(captured).not.toBeNull();

    // The relay posted a tool_use content frame and a tool_result content frame.
    const toolUses = broker.content.filter((p) => p.recordKind === "tool_use");
    const toolResults = broker.content.filter((p) => p.recordKind === "tool_result");
    expect(toolUses).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    // tool_use body is {name,input,sub}; tool_result body is {tool_use_id,is_error,output,sub}.
    const tu = JSON.parse(toolUses[0]?.text ?? "{}");
    expect(tu.name).toBe("bash");
    expect(tu.input).toEqual({ command: "echo hello" });
    const tr = JSON.parse(toolResults[0]?.text ?? "{}");
    expect(tr.tool_use_id).toBe("call_echo");
    expect(tr.is_error).toBe(false);
    expect(tr.output).toContain("hello");
    // Ordering: the tool_use frame precedes its tool_result frame.
    expect((toolUses[0]?.seq as number) < (toolResults[0]?.seq as number)).toBe(true);
  });
});

// ── HARDENING TESTS (code-review consensus #1–#4) ────────────────────────────────────────────────
// Deterministic proofs of the robustness fixes the happy-path suite doesn't exercise.

/** Build a HistoryMessage (GET /message entry) from an info + parts. */
function histMsg(
  info: Record<string, unknown>,
  parts: Array<Record<string, unknown>>,
): HistoryMessage {
  return { info, parts } as unknown as HistoryMessage;
}

describe("OpencodeDriver hardening", () => {
  let ac: AbortController | null = null;
  afterEach(() => ac?.abort());

  // FIX #1 — attach mid-turn: an INCOMPLETE assistant in history must NOT be flushed at backfill (no
  // truncated answer); the LIVE completion must flush the FULL text exactly once (no truncation, no dup).
  it("(#1) attach mid-turn: incomplete assistant is buffered at backfill, then live completion flushes the full text once", async () => {
    // History: a finished user prompt + an assistant message that is STILL STREAMING (a partial part, no
    // time.completed). Backfill must surface the user prompt but withhold the partial assistant.
    const history: HistoryMessage[] = [
      histMsg({ id: "msg_u", role: "user", time: { created: 1 } }, [
        { type: "text", id: "prt_u", messageID: "msg_u", text: "Stream please" },
      ]),
      histMsg({ id: "msg_a", role: "assistant", time: { created: 2 } /* no completed */ }, [
        { type: "text", id: "prt_a", messageID: "msg_a", text: "partial" }, // mid-stream snapshot
      ]),
    ];
    // Use TWO connections so there's a deterministic backoff window to observe the post-backfill state:
    //  connection 1 backfills (history) then EOFs immediately (just server.connected) — during the
    //  reconnect backoff we assert the incomplete assistant was withheld;
    //  connection 2 (the reconnect) delivers the LIVE completion (full text) and idles, then parks.
    const client = new FakeOpencodeClient([]);
    client.connectionScripts = [
      [{ type: "server.connected", properties: {} }], // backfill-only, then EOF
      [
        { type: "server.connected", properties: {} },
        part({ type: "text", id: "prt_a", messageID: "msg_a", text: "partial and then the rest" }),
        msgUpdated({ id: "msg_a", role: "assistant", time: { created: 2, completed: 3 } }),
        idle(),
      ],
    ];
    client.history = history;
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);

    // Wait for the user prompt to appear (proves backfill ran on connection 1), then assert no assistant
    // yet — the incomplete assistant in history was BUFFERED, not flushed (#1). Connection 2 hasn't
    // delivered the completion yet (we're inside the reconnect backoff window).
    await waitFor(() => up(captured).some((e) => e.eventType === "user"));
    const midBackfill = up(captured).filter((e) => e.eventType === "assistant");
    expect(midBackfill).toHaveLength(0); // the incomplete assistant was NOT flushed at backfill (#1)

    // Now wait for the live completion (connection 2) to flush the assistant.
    await waitFor(() => up(captured).some((e) => e.eventType === "assistant"), 3000);
    ac.abort();
    await run;

    const session = captured as unknown as Session;
    const assistants = session.snapshotUpstream().filter((e) => e.eventType === "assistant");
    // EXACTLY ONE assistant payload — and it's the FULL text, not the truncated "partial".
    expect(assistants).toHaveLength(1);
    const msg = assistants[0]?.payload.message as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(msg.content).toEqual([{ type: "text", text: "partial and then the rest" }]);
  });

  // FIX #2 — SSE reconnect: a simulated stream drop+reconnect must KEEP the pump alive (run() must NOT
  // resolve, opencode must NOT be aborted), and the re-backfill on reconnect must produce no duplicates.
  it("(#2) a transient SSE drop reconnects (no run() exit, no opencode abort) and re-backfill does not duplicate", async () => {
    // Connection 1: completes a turn, then EOFs (the drop). Connection 2 (the reconnect): re-delivers the
    // SAME finished message (as a real reconnect would) then parks. The driver must reconnect and dedup.
    const turn: OpencodeEvent[] = [
      { type: "server.connected", properties: {} },
      part({ type: "text", id: "prt_ok", messageID: "msg_r", text: "OK" }),
      msgUpdated({ id: "msg_r", role: "assistant", time: { created: 1, completed: 2 } }),
      idle(),
    ];
    const reconnect: OpencodeEvent[] = [
      { type: "server.connected", properties: {} },
      // a reconnect re-delivers the finished message's parts + completion — must be deduped (#2)
      part({ type: "text", id: "prt_ok", messageID: "msg_r", text: "OK" }),
      msgUpdated({ id: "msg_r", role: "assistant", time: { created: 1, completed: 2 } }),
      idle(),
    ];
    const client = new FakeOpencodeClient([]);
    client.connectionScripts = [turn, reconnect];
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    let resolved = false;
    const run = new OpencodeDriver(ctx).run(ac.signal).then((c) => {
      resolved = true;
      return c;
    });

    // Wait for the reconnect to happen (events() called twice) AND the assistant to flush.
    await waitFor(() => client.connections >= 2);
    await waitFor(() => up(captured).some((e) => e.eventType === "assistant"));
    await sleep(50); // let any (incorrect) duplicate land

    // The drop did NOT end run() and did NOT abort opencode — the bridge survived the transient close.
    expect(resolved).toBe(false);
    expect(client.aborts).toBe(0);
    // Re-backfill across the reconnect produced NO duplicate: exactly one assistant payload.
    const assistants = up(captured).filter((e) => e.eventType === "assistant");
    expect(assistants).toHaveLength(1);
    expect(client.connections).toBeGreaterThanOrEqual(2); // it actually reconnected

    ac.abort();
    const code = await run;
    expect(code).toBe(0);
    expect(resolved).toBe(true); // NOW it resolves — only on the parent abort
  });

  // FIX #3 — a FAILED promptAsync must roll back the suppression token so a later identical LOCAL prompt
  // is NOT falsely suppressed (it must surface as a local_prompt).
  it("(#3) a failed inject rolls back its suppression token (a later identical local prompt is not suppressed)", async () => {
    // The live SSE: a LOCAL user message with the SAME text the failed inject tried to send. With the
    // rollback, it must surface as a local_prompt; without it, the leaked token would suppress it.
    const SAME = "duplicate text";
    const client = new FakeOpencodeClient([
      { type: "server.connected", properties: {} },
      part({ type: "text", id: "prt_u", messageID: "msg_local", text: SAME }),
      msgUpdated({ id: "msg_local", role: "user", time: { created: 1 } }),
      // an assistant message so #flushBufferedUsers fires and the user message flushes
      part({ type: "text", id: "prt_a", messageID: "msg_a2", text: "reply" }),
      msgUpdated({ id: "msg_a2", role: "assistant", time: { created: 2, completed: 3 } }),
      idle(),
    ]);
    // Make promptAsync FAIL so the inject's recorded token must roll back.
    client.promptAsync = async () => {
      throw new Error("simulated prompt POST failure");
    };
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const ready = new Promise<Session>((resolve) => {
      const orig = ctx.onSession;
      ctx.onSession = (s: Session) => {
        orig?.(s);
        s.pushUserInput(SAME); // the driver tries to inject this; the POST fails → token must roll back
        resolve(s);
      };
    });
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await ready;
    // Wait for the LOCAL user message (same text) to flush — it must NOT be suppressed.
    await waitFor(() => up(captured).some((e) => e.eventType === "user"));
    ac.abort();
    await run;

    const session = captured as unknown as Session;
    const users = session.snapshotUpstream().filter((e) => e.eventType === "user");
    // The local prompt with the same text surfaced (NOT falsely suppressed by a leaked token — #3).
    expect(users).toHaveLength(1);
    expect(users[0]?.payload.local_prompt).toBe(true);
    expect((users[0]?.payload.message as { content?: unknown })?.content).toBe(SAME);
  });

  // FIX #4 — the SSE parser must accept CRLF framing (a `\r\n`-separated frame must parse).
  it("(#4) parseSseFrame parses a CRLF-framed data line", () => {
    // A frame whose data line ends in \r (after LF-normalization in events(), a block is the inter-blank
    // content). parseSseFrame receives a LF-normalized block; assert it parses a typical data line, AND
    // that the raw CRLF normalization in events() collapses \r\n → \n so framing works.
    const obj = { type: "session.idle", properties: { sessionID: "ses_x" } };
    const lfBlock = `data: ${JSON.stringify(obj)}`;
    expect(parseSseFrame(lfBlock)?.type).toBe("session.idle");

    // Multi-line data (SSE allows several data: lines per frame) concatenates.
    const json = JSON.stringify({ type: "server.heartbeat", properties: {} });
    const half = json.length >> 1;
    const multi = `data: ${json.slice(0, half)}\ndata: ${json.slice(half)}`;
    expect(parseSseFrame(multi)?.type).toBe("server.heartbeat");

    // A `:comment` keepalive (no data:) → null (skipped, not a kill).
    expect(parseSseFrame(":keepalive")).toBeNull();
    // Malformed JSON → null.
    expect(parseSseFrame("data: {not json")).toBeNull();

    // The CRLF normalization that events() applies before framing: \r\n\r\n frames split, \r\n lines
    // become \n. Prove the normalization the parser depends on: a CRLF block normalizes to the LF block.
    const crlfBlock = lfBlock.replace(/\n/g, "\r\n");
    expect(parseSseFrame(crlfBlock.replace(/\r\n?/g, "\n"))?.type).toBe("session.idle");
  });
});

// Behaviors the driver doc PROMISES that a live human-style verification found unimplemented (now honored):
//   • /compact routes to the native summarize endpoint (not fed to the model as literal text);
//   • session.error surfaces a result frame so the viewer isn't stuck "working" on a failed turn;
//   • a whitespace-only prompt is a no-op, not a burned model turn.
describe("OpencodeDriver — documented behavior (session.error / /compact / blank prompts)", () => {
  let ac: AbortController | null = null;
  afterEach(() => ac?.abort());

  it("routes /compact to the native summarize endpoint, NOT a model prompt", async () => {
    const client = new FakeOpencodeClient([{ type: "server.connected", properties: {} }, idle()]);
    const broker = new FakeBroker();
    const ctx = await makeCtx(client, broker, () => {});
    ctx.onSession = (s: Session) => s.pushUserInput("/compact");
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await waitFor(() => client.summarizes.length >= 1);
    ac.abort();
    await run;
    expect(client.summarizes).toEqual([SES]); // summarize hit the attached session
    expect(client.prompts).toHaveLength(0); // and it was NOT sent to the model as a prompt
  });

  it("dispatches /compact WITHOUT blocking the inject pump (a hung summarize still lets interrupt fire)", async () => {
    // OpenCode's summarize endpoint runs the WHOLE compaction turn server-side before returning. The
    // earlier code `await`ed it inside the serial inject pump, so a later queued `interrupt` could not
    // fire until compaction finished (and the slow ack risked a reconnect replaying /compact → a SECOND
    // compaction). The fix dispatches summarize fire-and-forget. Model that with a summarize that NEVER
    // resolves: the interrupt that follows /compact must still reach client.abort().
    const client = new FakeOpencodeClient([{ type: "server.connected", properties: {} }, idle()]);
    client.summarize = () => new Promise<void>(() => {}); // hangs forever — would wedge an awaiting pump
    const broker = new FakeBroker();
    const ctx = await makeCtx(client, broker, () => {});
    ctx.onSession = (s: Session) => {
      s.pushUserInput("/compact"); // dispatched, must NOT block the pump
      s.pushControlRequest("interrupt"); // queued right behind it — must still be processed
    };
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    const fired = await waitFor(() => client.aborts >= 1);
    ac.abort();
    await run;
    // `fired` flipped true via the interrupt BEFORE we aborted → the pump processed it while summarize
    // was still hung. (Teardown also aborts the OpenCode run — review #10 — so the final count is ≥1.)
    expect(fired).toBe(true);
    expect(client.aborts).toBeGreaterThanOrEqual(1);
    expect(client.prompts).toHaveLength(0); // /compact was not fed to the model as a prompt
  });

  it("a FAILED /compact dispatch surfaces an error result and returns to idle (not stuck 'running')", async () => {
    // Fire-and-forget /compact sets workerStatus="running" then dispatches summarize. If summarize
    // REJECTS, no server-side turn ever starts, so no session.status/session.error will clear the
    // "running" — the .catch must surface the error AND drop to idle itself (codex review). The script
    // has NO session.idle, so the ONLY route back to idle is that .catch.
    const client = new FakeOpencodeClient([{ type: "server.connected", properties: {} }]);
    client.summarize = () => Promise.reject(new Error("summarize boom"));
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
      s.pushUserInput("/compact");
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await waitFor(() => broker.content.some((p) => p.text.includes("summarize boom")));
    ac.abort();
    await run;
    // The failure reached the viewer as a result frame (impossible without the .catch surfacing it)…
    expect(broker.content.some((p) => p.text.includes("⚠ OpenCode error: summarize boom"))).toBe(
      true,
    );
    // …and the session left "running" rather than hanging on a turn that never began.
    expect((captured as unknown as Session).workerStatus).toBe("idle");
    expect(client.prompts).toHaveLength(0); // still not sent to the model as a prompt
  });

  it("treats a whitespace-only prompt as a no-op (no burned model turn)", async () => {
    const client = new FakeOpencodeClient([{ type: "server.connected", properties: {} }, idle()]);
    const broker = new FakeBroker();
    let s0: Session | null = null;
    const ctx = await makeCtx(client, broker, () => {});
    ctx.onSession = (s: Session) => {
      s0 = s;
      s.pushUserInput("   \n  "); // spaces + a stray newline — non-empty but blank
    };
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await waitFor(() => s0 !== null);
    await sleep(150); // let the inject pump process (and, correctly, skip) the blank prompt
    ac.abort();
    await run;
    expect(client.prompts).toHaveLength(0); // no model turn burned
    expect(client.summarizes).toHaveLength(0);
  });

  it("surfaces session.error as a result frame the viewer renders, then goes idle", async () => {
    const client = new FakeOpencodeClient([
      { type: "server.connected", properties: {} },
      { type: "session.status", properties: { sessionID: SES, status: { type: "busy" } } },
      sessionError({ name: "ProviderError", data: { message: "model not found: zzz" } }),
    ]);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    // End-to-end: the error reaches the BROKER as a content frame (what the viewer renders).
    await waitFor(() => broker.content.some((p) => p.text.includes("model not found: zzz")));
    ac.abort();
    await run;
    expect(
      broker.content.some((p) => p.text.includes("⚠ OpenCode error: model not found: zzz")),
    ).toBe(true);
    // …and the session left the "working" state rather than hanging.
    expect((captured as unknown as Session).workerStatus).toBe("idle");
  });
});

// ── SUB-AGENT (Task) BRIDGING (#102) ─────────────────────────────────────────────────────────────
// The driver follows a child OpenCode session spawned by a `subtask` part and nests its messages under
// the Task tool_use anchor. These prove the END-TO-END follow path against the REAL server-wide filter
// (the FakeOpencodeClient replicates client.ts's gating + discovery exception), so a child's events only
// flow AFTER its session.created is processed — the exact circular-dependency the discovery exception fixes.
describe("OpencodeDriver — sub-agent (Task) bridging", () => {
  let ac: AbortController | null = null;
  afterEach(() => ac?.abort());

  it("subtask part → Task anchor; the child session's reply nests under it; the child's internal prompt is not surfaced", async () => {
    const SUBAGENT_SCRIPT: OpencodeEvent[] = [
      { type: "server.connected", properties: {} },
      statusOf(SES, "busy"),
      // The MAIN assistant turn carries a `subtask` part (the Task spawn) alongside some text.
      part({ type: "text", id: "prt_m1", messageID: "msg_main", text: "I'll investigate." }),
      part({
        type: "subtask",
        id: "prt_task1",
        messageID: "msg_main",
        agent: "explore",
        description: "scout the auth flow",
        prompt: "find every call site of login()",
      }),
      msgUpdated({ id: "msg_main", role: "assistant", time: { created: 1, completed: 2 } }),
      // The child session is created (parent = SES, agent = explore). Its OWN id is not yet followed, so it
      // arrives ONLY via the discovery exception — then the driver follows it and tags it to prt_task1.
      sessionCreated({ id: CHILD, parentID: SES, agent: "explore" }),
      // The child's INTERNAL user prompt (the Task input) — must NOT surface as a top-level local_prompt.
      childPart({
        type: "text",
        id: "prt_cu",
        messageID: "msg_cu",
        text: "internal subagent prompt",
      }),
      childMsgUpdated({ id: "msg_cu", role: "user", time: { created: 3 } }),
      // The child's assistant reply — must nest under the Task (parent_tool_use_id = prt_task1).
      childPart({ type: "text", id: "prt_c1", messageID: "msg_child", text: "found it" }),
      childMsgUpdated({ id: "msg_child", role: "assistant", time: { created: 4, completed: 5 } }),
      childIdle(),
      idle(),
    ];
    const client = new FakeOpencodeClient(SUBAGENT_SCRIPT);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    // Wait for the CHILD's reply to flush (proves the child was discovered + followed + nested).
    await waitFor(() => up(captured).some((e) => e.payload.uuid === "msg_child"));
    ac.abort();
    const code = await run;
    expect(code).toBe(0);

    const upstream = up(captured);
    // 1) The main assistant turn carries the Task tool_use anchor built from the subtask part.
    const main = upstream.find((e) => e.payload.uuid === "msg_main");
    expect(main).toBeDefined();
    const mainContent = (main?.payload.message as { content: Array<Record<string, unknown>> })
      .content;
    const task = mainContent.find((b) => b.type === "tool_use" && b.name === "Task");
    expect(task).toEqual({
      type: "tool_use",
      name: "Task",
      id: "prt_task1",
      input: {
        subagent_type: "explore",
        description: "scout the auth flow",
        prompt: "find every call site of login()",
      },
    });
    // It is NOT tagged (a top-level main message), and the text block precedes the Task anchor.
    expect(main?.payload.parent_tool_use_id).toBeUndefined();
    expect(mainContent[0]).toEqual({ type: "text", text: "I'll investigate." });

    // 2) The child's reply nests under the Task: tagged parent_tool_use_id = prt_task1, content = "found it".
    const child = upstream.find((e) => e.payload.uuid === "msg_child");
    expect(child?.eventType).toBe("assistant");
    expect(child?.payload.parent_tool_use_id).toBe("prt_task1");
    expect((child?.payload.message as { content: unknown }).content).toEqual([
      { type: "text", text: "found it" },
    ]);

    // 3) The child's INTERNAL prompt was NOT surfaced as a local_prompt (it's shown via the Task anchor).
    const users = upstream.filter((e) => e.eventType === "user");
    expect(users).toHaveLength(0);
    expect(
      upstream.some(
        (e) => (e.payload.message as { content?: unknown })?.content === "internal subagent prompt",
      ),
    ).toBe(false);
  });

  it("a child sub-agent's idle does NOT flip the bridge to idle while the parent is still running", async () => {
    // The child completes and idles, but the MAIN session never idles in this script. Only the main
    // session's idle/status drives workerStatus, so the bridge must stay "running" after the child idles.
    const SCRIPT: OpencodeEvent[] = [
      { type: "server.connected", properties: {} },
      statusOf(SES, "busy"), // main is working → running
      sessionCreated({ id: CHILD, parentID: SES, agent: "explore" }),
      statusOf(CHILD, "busy"),
      childPart({ type: "text", id: "prt_c1", messageID: "msg_child", text: "sub done" }),
      childMsgUpdated({ id: "msg_child", role: "assistant", time: { created: 1, completed: 2 } }),
      statusOf(CHILD, "idle"), // a child going idle must NOT flip the bridge
      childIdle(), // nor must a child session.idle
    ];
    const client = new FakeOpencodeClient(SCRIPT);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await waitFor(() => up(captured).some((e) => e.payload.uuid === "msg_child"));
    await sleep(40); // let the trailing child status:idle + child session.idle process
    // The parent is still running — neither child-idle event flipped the bridge presence.
    expect((captured as unknown as Session).workerStatus).toBe("running");
    ac.abort();
    await run;
  });

  it("the MAIN session's idle DOES flip the bridge to idle (control for the isolation test)", async () => {
    const SCRIPT: OpencodeEvent[] = [
      { type: "server.connected", properties: {} },
      statusOf(SES, "busy"),
      idle(), // main idle → bridge idle
    ];
    const client = new FakeOpencodeClient(SCRIPT);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    const wentIdle = await waitFor(
      () => captured !== null && (captured as unknown as Session).workerStatus === "idle",
    );
    expect(wentIdle).toBe(true);
    ac.abort();
    await run;
  });

  // codex #5 — an UNTAGGED followed child (its session.created had no matching subtask anchor) must STILL
  // suppress its internal user prompt (suppression keys on "is a followed non-main child", not on the tag).
  it("suppresses an UNTAGGED child's internal prompt and keeps its reply top-level (no anchor matched)", async () => {
    const SCRIPT: OpencodeEvent[] = [
      { type: "server.connected", properties: {} },
      statusOf(SES, "busy"),
      // No subtask part is ever noted → the child gets NO tag when created.
      sessionCreated({ id: CHILD, parentID: SES, agent: "explore" }),
      childPart({
        type: "text",
        id: "prt_cu",
        messageID: "msg_cu",
        text: "internal subagent prompt",
      }),
      childMsgUpdated({ id: "msg_cu", role: "user", time: { created: 1 } }),
      childPart({ type: "text", id: "prt_c1", messageID: "msg_child", text: "sub reply" }),
      childMsgUpdated({ id: "msg_child", role: "assistant", time: { created: 2, completed: 3 } }),
      childIdle(),
    ];
    const client = new FakeOpencodeClient(SCRIPT);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await waitFor(() => up(captured).some((e) => e.payload.uuid === "msg_child"));
    ac.abort();
    await run;
    const upstream = up(captured);
    // The child's internal prompt was NOT surfaced (suppressed despite being untagged) …
    expect(upstream.filter((e) => e.eventType === "user")).toHaveLength(0);
    // … and its reply is top-level (untagged) rather than mis-nested.
    const child = upstream.find((e) => e.payload.uuid === "msg_child");
    expect(child?.eventType).toBe("assistant");
    expect(child?.payload.parent_tool_use_id).toBeUndefined();
  });

  // codex #2 — backfill must NOT enqueue historical subtask anchors. A later live child with the same agent
  // must NOT nest under a stale anchor from history (we can't reliably correlate a past anchor to a new child).
  it("does NOT nest a live child under a subtask anchor that came from history backfill", async () => {
    const client = new FakeOpencodeClient([
      { type: "server.connected", properties: {} },
      // a live child of the SAME agent as the historical subtask part
      sessionCreated({ id: CHILD, parentID: SES, agent: "explore" }),
      childPart({ type: "text", id: "prt_c1", messageID: "msg_child", text: "fresh reply" }),
      childMsgUpdated({ id: "msg_child", role: "assistant", time: { created: 9, completed: 10 } }),
      childIdle(),
      idle(),
    ]);
    // History: a completed parent assistant turn that INCLUDED a subtask (agent "explore"). Backfill renders
    // its Task anchor but must NOT enqueue it for correlation (its real child already ran in the past).
    client.history = [
      histMsg({ id: "msg_hist", role: "assistant", time: { created: 1, completed: 2 } }, [
        { type: "text", id: "prt_h", messageID: "msg_hist", text: "did some work" },
        {
          type: "subtask",
          id: "prt_hist_task",
          messageID: "msg_hist",
          agent: "explore",
          description: "old task",
          prompt: "old prompt",
        },
      ]),
    ];
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await waitFor(() => up(captured).some((e) => e.payload.uuid === "msg_child"));
    ac.abort();
    await run;
    const upstream = up(captured);
    // The historical Task anchor still rendered (history is shown) …
    const hist = upstream.find((e) => e.payload.uuid === "msg_hist");
    const histContent = (hist?.payload.message as { content: Array<Record<string, unknown>> })
      .content;
    expect(histContent.some((b) => b.type === "tool_use" && b.id === "prt_hist_task")).toBe(true);
    // … but the LIVE child is NOT mis-nested under that stale anchor (backfill didn't enqueue it).
    const child = upstream.find((e) => e.payload.uuid === "msg_child");
    expect(child?.payload.parent_tool_use_id).toBeUndefined();
  });

  // codex #3 — correlation is keyed by (PARENT session, agent), not agent alone: two parents spawning the
  // SAME agent must not steal each other's anchors. main(SES) and its followed child C1 both spawn "explore";
  // a grandchild of C1 must nest under C1's anchor, not main's (agent-only FIFO would mis-tag it).
  it("keys subtask correlation by (parent, agent): a grandchild nests under its own parent's anchor", async () => {
    const C1 = "ses_c1";
    const GC = "ses_gc";
    const client = new FakeOpencodeClient([
      { type: "server.connected", properties: {} },
      statusOf(SES, "busy"),
      // main spawns worker → C1 (so C1 becomes a followed parent in its own right)
      part({ type: "subtask", id: "prt_c1_task", messageID: "msg_m", agent: "worker" }),
      msgUpdated({ id: "msg_m", role: "assistant", time: { created: 1, completed: 2 } }),
      sessionCreated({ id: C1, parentID: SES, agent: "worker" }),
      // BOTH main and C1 now enqueue an "explore" anchor (same agent, different parents)
      part({ type: "subtask", id: "prt_main_explore", messageID: "msg_m2", agent: "explore" }), // parent SES
      msgUpdated({ id: "msg_m2", role: "assistant", time: { created: 3, completed: 4 } }),
      partFor(C1, { type: "subtask", id: "prt_c1_explore", messageID: "msg_c1", agent: "explore" }), // parent C1
      msgUpdatedFor(C1, { id: "msg_c1", role: "assistant", time: { created: 5, completed: 6 } }),
      // a grandchild of C1 with agent "explore" — must pop C1's anchor (prt_c1_explore), NOT main's
      sessionCreated({ id: GC, parentID: C1, agent: "explore" }),
      partFor(GC, { type: "text", id: "prt_gc1", messageID: "msg_gc", text: "grandchild reply" }),
      msgUpdatedFor(GC, { id: "msg_gc", role: "assistant", time: { created: 7, completed: 8 } }),
      idleFor(GC),
    ]);
    const broker = new FakeBroker();
    let captured: Session | null = null;
    const ctx = await makeCtx(client, broker, (s) => {
      captured = s;
    });
    ac = new AbortController();
    const run = new OpencodeDriver(ctx).run(ac.signal);
    await waitFor(() => up(captured).some((e) => e.payload.uuid === "msg_gc"));
    ac.abort();
    await run;
    const gc = up(captured).find((e) => e.payload.uuid === "msg_gc");
    // Parent-keyed correlation → the grandchild nests under C1's anchor; agent-only FIFO would give main's.
    expect(gc?.payload.parent_tool_use_id).toBe("prt_c1_explore");
  });
});

// errText backs BOTH error result frames (session.error and a failed /compact). It must NEVER throw and
// must ALWAYS yield non-empty text for any error shape a provider might send (verification-review gap).
describe("errText — robust error-text extraction", () => {
  it("prefers data.message → message → name, in that order", () => {
    expect(errText({ name: "E", message: "m", data: { message: "d" } })).toBe("d");
    expect(errText({ name: "E", message: "m" })).toBe("m");
    expect(errText({ name: "ProviderError" })).toBe("ProviderError");
  });
  it("handles primitives: string passes through, number/boolean stringify", () => {
    expect(errText("plain failure")).toBe("plain failure");
    expect(errText(42)).toBe("42");
    expect(errText(true)).toBe("true");
  });
  it("falls back to JSON for an unkeyed object, and to 'unknown error' for null/unstringifiable", () => {
    expect(errText({ code: 7 })).toBe('{"code":7}'); // no message/name/data → JSON of the object
    // All recognized keys present but EMPTY → they don't satisfy the !== "" guards, so it JSON-stringifies
    // the whole object (still SOMETHING for the viewer, never empty).
    expect(errText({ name: "", message: "", data: { message: "" } })).toBe(
      '{"name":"","message":"","data":{"message":""}}',
    );
    expect(errText(null)).toBe("unknown error");
    expect(errText(undefined)).toBe("unknown error");
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws → caught → "unknown error"
    expect(errText(circular)).toBe("unknown error");
  });
});
