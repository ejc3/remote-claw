// Unit tests for the RC session event bus, ported from the retired Phase 0 TestCore plus
// TestClientEvent, plus async-generator-specific coverage (heartbeat ticks, supersede, close).

import { describe, expect, it } from "vitest";
import {
  assistantText,
  NativeUpstreamAdmissionError,
  permissionModeFrom,
  type RcEvent,
  RelayCore,
  Session,
} from "./session.js";

const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";

function nativeEvent(
  uuid: string,
  type = "assistant",
  extra: Record<string, unknown> = {},
  sessionId = "cse_x",
): { payload: Record<string, unknown> } {
  return { payload: { uuid, type, session_id: sessionId, ...extra } };
}

function expectAdmissionStatus(fn: () => unknown, status: 400 | 409 | 410): void {
  try {
    fn();
    throw new Error("expected native admission to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(NativeUpstreamAdmissionError);
    expect((error as NativeUpstreamAdmissionError).status).toBe(status);
  }
}

/** Drain a follower generator until `n` non-null events arrive (or it ends), returning those events. */
async function takeEvents(gen: AsyncGenerator<RcEvent | null>, n: number): Promise<RcEvent[]> {
  const out: RcEvent[] = [];
  for await (const ev of gen) {
    if (ev !== null) {
      out.push(ev);
      if (out.length >= n) break;
    }
  }
  return out;
}

/** Drain a follower to exhaustion (it must already be closed/superseded, else this never returns). */
async function drain(gen: AsyncGenerator<RcEvent | null>): Promise<RcEvent[]> {
  const out: RcEvent[] = [];
  for await (const ev of gen) if (ev !== null) out.push(ev);
  return out;
}

describe("RelayCore", () => {
  it("creates a cse_-prefixed session and gets it back", () => {
    const c = new RelayCore();
    const s = c.create({ title: "t" });
    expect(s.id.startsWith("cse_")).toBe(true);
    expect(c.get(s.id)).toBe(s);
    expect(c.get("nope")).toBeUndefined();
  });

  it("mints a globally-unique session id per launch — no cross-launch collision (K1)", () => {
    // Two RelayCores model two process launches. The old counter-based id reset to 0 each launch, so
    // the FIRST session of every launch was `cse_12654435761` — under one identity that is the SAME
    // broker channel (`sess:<id>:<sessionId>`), corrupting a durable session's frames. Ids must differ.
    const a = new RelayCore().create({ title: "t" }).id;
    const b = new RelayCore().create({ title: "t" }).id;
    expect(a).not.toBe(b);
    // Shape: cse_ + a 32-hex crypto.randomUUID body (dashes stripped) — valid channel-token charset.
    expect(a).toMatch(/^cse_[0-9a-f]{32}$/);
    expect(b).toMatch(/^cse_[0-9a-f]{32}$/);
  });

  it("accepts an injected deterministic session-id minter (test determinism)", () => {
    let n = 0;
    const c = new RelayCore({ newSessionId: () => `fixed${++n}` });
    expect(c.create({ title: "t" }).id).toBe("cse_fixed1");
    expect(c.create({ title: "t" }).id).toBe("cse_fixed2");
  });

  it("closeAll is idempotent and Session.close is safe to call twice", async () => {
    const c = new RelayCore({ newSessionId: () => "fixed" });
    const s = c.create({ title: "t" });
    const gen = s.claimWorkerStream();

    s.close();
    s.close();
    c.closeAll();
    c.closeAll();

    expect(s.closed).toBe(true);
    expect(await drain(s.followDownstream(gen, () => false))).toEqual([]);
  });
});

describe("Session producers", () => {
  it("seeds permissionMode from config and recognizes system-init spellings", () => {
    expect(new Session("cse_x", "t", { permissionMode: "default" }).permissionMode).toBe("default");
    expect(new Session("cse_x", "t", { permission_mode: "plan" }).permissionMode).toBe("plan");
    expect(new Session("cse_x", "t", { config: { permissionMode: "auto" } }).permissionMode).toBe(
      "auto",
    );
    expect(permissionModeFrom({ permissionMode: "bypassPermissions" })).toBe("bypassPermissions");
    expect(permissionModeFrom({ permissionMode: "" })).toBeNull();
  });

  it("pushUserInput builds a client `user` event", () => {
    const s = new Session("cse_x", "t", {});
    const ev = s.pushUserInput("hello");
    expect(ev.eventType).toBe("user");
    expect((ev.payload.message as { content: string }).content).toBe("hello");
    expect(ev.source).toBe("client");
    expect(ev.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(ev.payload.uuid).toBe(ev.eventId);
    // The real worker echoes a remote user event upstream. Producer and strict native validator must
    // agree on the coordinate shape; this was the real-Claude fail-stop regression.
    expect(
      s.ingestNativeUpstreamBatch(1, [{ payload: { ...ev.payload } }])[0]?.event.payload,
    ).toEqual(ev.payload);
  });

  it("pushInitialize is idempotent (once per session)", () => {
    const s = new Session("cse_x", "t", {});
    expect(s.pushInitialize()).not.toBeNull();
    expect(s.pushInitialize()).toBeNull();
  });

  it("initialize occupies downstream sequence 1 even if a user push races after", async () => {
    const s = new Session("cse_x", "t", {});
    s.pushInitialize();
    s.pushUserInput("hi");
    const gen = s.claimWorkerStream();
    const out = await takeEvents(
      s.followDownstream(gen, () => false),
      2,
    );
    expect(out[0]?.sequenceNum).toBe(1);
    expect((out[0]?.payload.request as { subtype: string }).subtype).toBe("initialize");
    expect(out[1]?.eventType).toBe("user");
  });

  it("pushUpstream records a worker event recoverable via snapshot", () => {
    const s = new Session("cse_x", "t", {});
    s.pushUpstream({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    const snap = s.snapshotUpstream();
    expect(snap).toHaveLength(1);
    expect(assistantText(snap[0]?.payload ?? {})).toBe("hi");
  });

  it("pushControlResponse answers a permission request (allow)", () => {
    const s = new Session("cse_x", "t", {});
    const ev = s.pushControlResponse("r1", "allow");
    expect(ev.eventType).toBe("control_response");
    const resp = ev.payload.response as { request_id: string; response: { behavior: string } };
    expect(resp.request_id).toBe("r1");
    expect(resp.response.behavior).toBe("allow");
  });

  it("pushControlResponse builds the AskUserQuestion answer shape (toolUseID + updatedInput.{questions,answers})", () => {
    // Real claude's AskUserQuestion runs call({questions, answers}); updatedInput MUST carry BOTH or it
    // throws "undefined is not an object (evaluating 'q.map')". Verified vs the claude 2.1.x binary.
    const s = new Session("cse_x", "t", {});
    const questions = [
      { question: "Which name?", header: "Name", multiSelect: false, options: [] },
    ];
    const ev = s.pushControlResponse("req-1", "allow", {
      toolUseId: "toolu_abc",
      answers: { "Which name?": "Orion" },
      questions,
    });
    const resp = ev.payload.response as {
      request_id: string;
      response: {
        behavior: string;
        toolUseID: string;
        updatedInput: { questions: unknown; answers: unknown };
      };
    };
    expect(resp.request_id).toBe("req-1");
    expect(resp.response.behavior).toBe("allow");
    expect(resp.response.toolUseID).toBe("toolu_abc");
    expect(resp.response.updatedInput.questions).toEqual(questions); // echoed back — the fix
    expect(resp.response.updatedInput.answers).toEqual({ "Which name?": "Orion" });
  });

  it("pushControlResponse carries an ARBITRARY freeform answer string (not among the options) unchanged (#42 freeform)", () => {
    // The viewer always offers a "type your own answer" input; the typed string is NOT necessarily one of
    // the option labels. session builds updatedInput with NO membership check, so a freeform answer flows
    // through verbatim — this locks that in (the protocol path already supports it; only the UI was missing).
    const s = new Session("cse_x", "t", {});
    const questions = [
      {
        question: "Which name?",
        header: "Name",
        multiSelect: false,
        options: [{ label: "Orion" }, { label: "Sable" }],
      },
    ];
    const ev = s.pushControlResponse("req-ff", "allow", {
      toolUseId: "toolu_ff",
      answers: { "Which name?": "Nebula (my own pick)" }, // not an option label
      questions,
    });
    const resp = ev.payload.response as {
      response: { updatedInput: { answers: Record<string, string> } };
    };
    expect(resp.response.updatedInput.answers).toEqual({ "Which name?": "Nebula (my own pick)" });
  });

  it("pushControlResponse falls back to updatedInput.{answers} when no questions are stashed", () => {
    const s = new Session("cse_x", "t", {});
    const ev = s.pushControlResponse("req-2", "allow", { answers: { Q: "A" } });
    const resp = ev.payload.response as { response: { updatedInput: Record<string, unknown> } };
    expect(resp.response.updatedInput).toEqual({ answers: { Q: "A" } }); // no questions key when absent
  });

  it("pushControlResponse omits toolUseID/updatedInput for a plain allow/deny", () => {
    const s = new Session("cse_x", "t", {});
    const resp = s.pushControlResponse("r2", "deny").payload.response as {
      response: Record<string, unknown>;
    };
    expect(resp.response).toEqual({ behavior: "deny" }); // no toolUseID, no updatedInput
  });

  it("pushControlRequest builds a server→worker control_request with subtype + params (§3.7)", () => {
    const s = new Session("cse_x", "t", {});
    const ev = s.pushControlRequest("set_model", { model: "claude-opus-4-8" });
    expect(ev.eventType).toBe("control_request");
    const req = ev.payload.request as { subtype: string; model: string };
    expect(req.subtype).toBe("set_model");
    expect(req.model).toBe("claude-opus-4-8");
    expect(typeof ev.payload.request_id).toBe("string");
    // A param-less verb still carries just the subtype.
    expect((s.pushControlRequest("interrupt").payload.request as { subtype: string }).subtype).toBe(
      "interrupt",
    );
  });
});

describe("Claude-native upstream admission", () => {
  it("admits exactly the retained eight event types with UUIDv4 coordinates", () => {
    const s = new Session("cse_x", "t", {});
    const types = [
      "assistant",
      "control_cancel_request",
      "control_request",
      "control_response",
      "rate_limit_event",
      "result",
      "system",
      "user",
    ];
    const events = types.map((type, index) =>
      nativeEvent(`0000000${index}-0000-4000-8000-00000000000${index}`, type),
    );

    const admitted = s.ingestNativeUpstreamBatch(1, events);

    expect(admitted.map(({ event }) => event.eventType)).toEqual(types);
    expect(admitted.every(({ duplicate }) => !duplicate)).toBe(true);
    expect(s.snapshotUpstream()).toHaveLength(8);
    expectAdmissionStatus(
      () => s.ingestNativeUpstreamBatch(1, [nativeEvent(UUID_1, "future_event")]),
      400,
    );
    expect(s.closed).toBe(true);
  });

  it("returns the original RcEvent for exact same-session retries", () => {
    const s = new Session("cse_x", "t", {});
    const firstPayload = nativeEvent(UUID_1, "assistant", { message: { content: [] } });
    const first = s.ingestNativeUpstreamBatch(1, [firstPayload])[0];
    const retry = s.ingestNativeUpstreamBatch(1, [
      nativeEvent(UUID_1, "assistant", { message: { content: [] } }),
    ])[0];

    expect(first?.duplicate).toBe(false);
    expect(retry?.duplicate).toBe(true);
    expect(retry?.event).toBe(first?.event);
    expect(retry?.event.sequenceNum).toBe(1);
    expect(s.snapshotUpstream()).toHaveLength(1);
  });

  it("deduplicates an exact intra-batch repeat against its first committed event", () => {
    const s = new Session("cse_x", "t", {});
    const payload = nativeEvent(UUID_1, "result", { result: "done" });

    const admitted = s.ingestNativeUpstreamBatch(1, [payload, payload]);

    expect(admitted.map(({ duplicate }) => duplicate)).toEqual([false, true]);
    expect(admitted[1]?.event).toBe(admitted[0]?.event);
    expect(s.snapshotUpstream()).toHaveLength(1);
  });

  it("terminally rejects changed normalized payload bytes at a retained UUID", () => {
    const s = new Session("cse_x", "t", {});
    s.ingestNativeUpstreamBatch(1, [nativeEvent(UUID_1, "assistant", { value: 1 })]);

    expectAdmissionStatus(
      () => s.ingestNativeUpstreamBatch(1, [nativeEvent(UUID_1, "assistant", { value: 2 })]),
      409,
    );
    expect(s.closed).toBe(true);
    expect(s.snapshotUpstream()).toHaveLength(1);
    expectAdmissionStatus(() => s.ingestNativeUpstreamBatch(1, [nativeEvent(UUID_2)]), 410);
  });

  it("treats normalized JSON property order as part of the terminal UUID identity", () => {
    const s = new Session("cse_x", "t", {});
    s.ingestNativeUpstreamBatch(1, [nativeEvent(UUID_1, "assistant", { value: 1 })]);

    // JSON property order is part of Buffer(JSON.stringify(payload)) identity, even when values match.
    expectAdmissionStatus(
      () =>
        s.ingestNativeUpstreamBatch(1, [
          { payload: { type: "assistant", uuid: UUID_1, session_id: "cse_x", value: 1 } },
        ]),
      409,
    );
    expect(s.closed).toBe(true);
    expect(s.snapshotUpstream()).toHaveLength(1);
  });

  it("preflights the whole batch, including intra-batch collisions, before any mutation", () => {
    const collisionSession = new Session("cse_collision", "t", {});
    expectAdmissionStatus(
      () =>
        collisionSession.ingestNativeUpstreamBatch(1, [
          nativeEvent(UUID_1, "assistant", { value: 1 }, collisionSession.id),
          nativeEvent(UUID_1, "assistant", { value: 2 }, collisionSession.id),
        ]),
      409,
    );
    expect(collisionSession.closed).toBe(true);
    expect(collisionSession.snapshotUpstream()).toEqual([]);

    const invalidSession = new Session("cse_invalid", "t", {});
    expectAdmissionStatus(
      () =>
        invalidSession.ingestNativeUpstreamBatch(1, [
          nativeEvent(UUID_1, "assistant", {}, invalidSession.id),
          nativeEvent("not-a-uuid", "result", {}, invalidSession.id),
        ]),
      400,
    );
    expect(invalidSession.closed).toBe(true);
    expect(invalidSession.snapshotUpstream()).toEqual([]);
  });

  it("terminally rejects absent/stale epochs or a non-array batch", () => {
    const invalidCases: Array<[unknown, unknown]> = [
      [undefined, []],
      ["1", []],
      [2, []],
      [1, {}],
    ];
    for (const [epoch, events] of invalidCases) {
      const s = new Session("cse_x", "t", {});
      expectAdmissionStatus(() => s.ingestNativeUpstreamBatch(epoch, events), 400);
      expect(s.closed).toBe(true);
      expect(s.snapshotUpstream()).toEqual([]);
    }

    const closed = new Session("cse_closed", "t", {});
    closed.close();
    expectAdmissionStatus(() => closed.ingestNativeUpstreamBatch(1, [nativeEvent(UUID_1)]), 410);
    expect(closed.snapshotUpstream()).toEqual([]);
  });

  it("terminally rejects a valid event bound to a sibling cse without harming that sibling", () => {
    const a = new Session("cse_a", "a", {});
    const b = new Session("cse_b", "b", {});

    expectAdmissionStatus(
      () => a.ingestNativeUpstreamBatch(1, [nativeEvent(UUID_1, "assistant", {}, b.id)]),
      400,
    );

    expect(a.closed).toBe(true);
    expect(a.snapshotUpstream()).toEqual([]);
    expect(b.closed).toBe(false);
    expect(
      b.ingestNativeUpstreamBatch(1, [nativeEvent(UUID_2, "assistant", {}, b.id)])[0]?.duplicate,
    ).toBe(false);
  });
});

describe("Session followers", () => {
  it("a worker follower skips already-acked downstream events", async () => {
    const s = new Session("cse_x", "t", {});
    const e1 = s.pushUserInput("a");
    s.ack(e1.eventId); // already delivered before this stream
    s.pushUserInput("b");
    const gen = s.claimWorkerStream();
    const out = await takeEvents(
      s.followDownstream(gen, () => false),
      1,
    );
    expect(out.map((e) => (e.payload.message as { content: string }).content)).toEqual(["b"]);
  });

  it("a newer worker stream supersedes an older follower (no duplicate delivery)", async () => {
    const s = new Session("cse_x", "t", {});
    const g1 = s.claimWorkerStream();
    s.claimWorkerStream(); // supersedes g1
    expect(await drain(s.followDownstream(g1, () => false))).toEqual([]);
  });

  it("reconnects may retry only the genuine minted initialize event", async () => {
    const s = new Session("cse_x", "t", {});
    const initialize = s.pushInitialize();
    if (initialize === null) throw new Error("initialize missing");

    const g1 = s.claimWorkerStream();
    const first = s.followDownstream(g1, () => false);
    expect((await first.next()).value).toBe(initialize);
    expect(s.claimDownstreamWriteAttempt(g1, initialize.eventId)).toBe(true);
    await first.return(undefined);

    const g2 = s.claimWorkerStream();
    const second = s.followDownstream(g2, () => false);
    expect((await second.next()).value).toBe(initialize);
    expect(s.claimDownstreamWriteAttempt(g2, initialize.eventId)).toBe(true);
    await second.return(undefined);
  });

  it("atomically accepts native delivery acks only after the matching SSE write attempt", async () => {
    const s = new Session("cse_x", "t", {});
    const initialize = s.pushInitialize();
    if (initialize === null) throw new Error("initialize missing");
    const user = s.pushUserInput("once");

    expect(s.acknowledgeNativeDeliveryBatch([initialize.eventId])).toBe(false);
    expect(s.acknowledgeNativeDeliveryBatch([user.eventId])).toBe(false);

    const firstGeneration = s.claimWorkerStream();
    expect(s.claimDownstreamWriteAttempt(firstGeneration, initialize.eventId)).toBe(true);
    expect(s.claimDownstreamWriteAttempt(firstGeneration, user.eventId)).toBe(true);
    expect(s.acknowledgeNativeDeliveryBatch([initialize.eventId, "future-event-id"])).toBe(false);

    // The invalid mixed batch admitted nothing: initialize remains reconnectable until a valid ack.
    const secondGeneration = s.claimWorkerStream();
    const reconnect = s.followDownstream(secondGeneration, () => false);
    expect((await reconnect.next()).value).toBe(initialize);
    await reconnect.return(undefined);

    expect(s.acknowledgeNativeDeliveryBatch([initialize.eventId, user.eventId])).toBe(true);
    s.close();
    expect(await drain(s.followDownstream(s.claimWorkerStream(), () => false))).toEqual([]);
  });

  it("retires only a native stream with an ambiguous mutating write", () => {
    const ambiguous = new Session("cse_ambiguous", "t", {});
    const mutation = ambiguous.pushUserInput("once");
    const generation = ambiguous.claimNativeWorkerStream();
    if (generation === null) throw new Error("native stream did not start");
    expect(ambiguous.claimDownstreamWriteAttempt(generation, mutation.eventId)).toBe(true);
    ambiguous.endNativeWorkerStream(generation);
    expect(ambiguous.closed).toBe(true);
    expect(ambiguous.claimNativeWorkerStream()).toBeNull();

    const acknowledged = new Session("cse_acked", "t", {});
    const delivered = acknowledged.pushUserInput("once");
    const acknowledgedGeneration = acknowledged.claimNativeWorkerStream();
    if (acknowledgedGeneration === null) throw new Error("native stream did not start");
    expect(
      acknowledged.claimDownstreamWriteAttempt(acknowledgedGeneration, delivered.eventId),
    ).toBe(true);
    expect(acknowledged.acknowledgeNativeDeliveryBatch([delivered.eventId])).toBe(true);
    acknowledged.endNativeWorkerStream(acknowledgedGeneration);
    expect(acknowledged.closed).toBe(false);
    expect(acknowledged.claimNativeWorkerStream()).not.toBeNull();
  });

  it("never offers a mutating downstream event after its first write attempt", async () => {
    const s = new Session("cse_x", "t", {});
    const user = s.pushUserInput("once");
    const g1 = s.claimWorkerStream();
    const first = s.followDownstream(g1, () => false);
    expect((await first.next()).value).toBe(user);
    expect(s.claimDownstreamWriteAttempt(g1, user.eventId)).toBe(true);
    await first.return(undefined);

    const g2 = s.claimWorkerStream();
    const second = s.followDownstream(g2, () => false);
    const next = second.next();
    queueMicrotask(() => s.close());
    expect(await next).toEqual({ value: undefined, done: true });
    expect(s.claimDownstreamWriteAttempt(g2, user.eventId)).toBe(false);
  });

  it("fences every downstream mutation by minted identity, including a lookalike initialize", () => {
    const s = new Session("cse_x", "t", {});
    const mutations = [
      s.pushUserInput("once"),
      s.pushControlResponse("request-1", "deny"),
      s.pushControlRequest("initialize"),
    ];
    const firstGeneration = s.claimWorkerStream();
    for (const event of mutations) {
      expect(s.claimDownstreamWriteAttempt(firstGeneration, event.eventId)).toBe(true);
    }

    const reconnectGeneration = s.claimWorkerStream();
    for (const event of mutations) {
      expect(s.claimDownstreamWriteAttempt(reconnectGeneration, event.eventId)).toBe(false);
    }
  });

  it("fences a stale generation and rechecks generation between buffered yields", async () => {
    const s = new Session("cse_x", "t", {});
    const firstEvent = s.pushUserInput("first");
    s.pushUserInput("second");
    const g1 = s.claimWorkerStream();
    const stale = s.followDownstream(g1, () => false);
    expect((await stale.next()).value).toBe(firstEvent);

    const g2 = s.claimWorkerStream();
    expect(s.claimDownstreamWriteAttempt(g1, firstEvent.eventId)).toBe(false);
    expect(await stale.next()).toEqual({ value: undefined, done: true });

    const current = s.followDownstream(g2, () => false);
    expect((await current.next()).value).toBe(firstEvent);
    expect(s.claimDownstreamWriteAttempt(g2, firstEvent.eventId)).toBe(true);
    await current.return(undefined);
  });

  it("rejects a downstream write fence after ack or close", () => {
    const s = new Session("cse_x", "t", {});
    const acked = s.pushUserInput("acked");
    let gen = s.claimWorkerStream();
    s.ack(acked.eventId);
    expect(s.claimDownstreamWriteAttempt(gen, acked.eventId)).toBe(false);

    const closed = s.pushUserInput("closed");
    gen = s.claimWorkerStream();
    s.close();
    expect(s.claimDownstreamWriteAttempt(gen, closed.eventId)).toBe(false);
  });

  it("close stops both downstream and upstream followers", async () => {
    const s = new Session("cse_x", "t", {});
    const g = s.claimWorkerStream();
    s.close();
    expect(await drain(s.followDownstream(g, () => false))).toEqual([]);
    expect(await drain(s.followUpstream(() => false))).toEqual([]);
    expect(s.pushInitialize()).toBeNull();
    expect(() => s.pushUserInput("late")).toThrow("session closed");
    expect(() => s.pushControlRequest("interrupt")).toThrow("session closed");
    expect(() => s.pushControlResponse("late", "deny")).toThrow("session closed");
    expect(() => s.pushUpstream({ type: "result" })).toThrow("session closed");
  });

  it("publishes the terminal edge synchronously once and immediately to late observers", () => {
    const s = new Session("cse_x", "t", {});
    const seen: string[] = [];
    const remove = s.onClose(() => seen.push("first"));
    s.onClose(() => seen.push("second"));

    s.close("first cause");
    s.close("later cause");
    expect(seen).toEqual(["first", "second"]);
    expect(s.closeReason).toBe("first cause");

    remove(); // idempotent after the listener set has already been cleared
    s.onClose(() => seen.push("late"));
    expect(seen).toEqual(["first", "second", "late"]);
  });

  it("one throwing close observer cannot hide terminality from the others", () => {
    const s = new Session("cse_x", "t", {});
    let observed = false;
    s.onClose(() => {
      throw new Error("observer failed");
    });
    s.onClose(() => {
      observed = true;
    });

    expect(() => s.close()).not.toThrow();
    expect(observed).toBe(true);
  });

  it("an upstream follower delivers events live to a client", async () => {
    const s = new Session("cse_x", "t", {});
    const gen = s.followUpstream(() => false);
    s.pushUpstream({ type: "assistant", message: { content: [{ type: "text", text: "yo" }] } });
    s.pushUpstream({ type: "result", result: "done" });
    const out = await takeEvents(gen, 2);
    expect(out.map((e) => e.eventType)).toEqual(["assistant", "result"]);
  });
});
