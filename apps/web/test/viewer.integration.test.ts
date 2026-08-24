import { encodeFrame, formatPass, type Identity, utf8 } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { connState, SessionTerminalError, Viewer } from "../app/lib/viewer";
import { brokerFetch, header } from "./e2e/harness";
import { uniqueIdentity } from "./helpers";

afterAll(async () => {
  await teardownWorkflowTests();
});

const never = new AbortController().signal;

/** Read up to `n` values from an async generator, then stop (break cancels the live stream). */
async function takeGen<T>(gen: AsyncGenerator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

/** A minimal fake host driven by the same transport, for the viewer to talk to. */
function fakeHost(id: Identity): BrokerClient {
  return new BrokerClient({
    baseUrl: "http://broker",
    provider: securityProvider("sealed", id),
    fetchFn: brokerFetch,
  });
}

describe("web client Viewer (browser-safe, against the real broker)", () => {
  it("caps a future host clock at local receipt so a crashed host cannot stay fresh indefinitely", async () => {
    const id = await uniqueIdentity();
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const host = fakeHost(id);
    const sid = "future-host-clock";
    const beforeReceipt = Date.now();
    const futureSentAt = beforeReceipt + 24 * 60 * 60_000;

    await host.postFrame(
      header(id, { recordKind: "session_announce", sessionId: sid, msgId: "ann-future" }),
      utf8(JSON.stringify({ session_id: sid, title: "future", sent_at: futureSentAt })),
    );
    const [discovered] = await takeGen(viewer.announces(never), 1);
    const afterReceipt = Date.now();

    expect(discovered?.sentAt).toBe(futureSentAt);
    expect(discovered).toBeDefined();
    expect(connState(discovered?.freshnessAt ?? 0, afterReceipt)).not.toBe("connected");
  });

  it("loads a pass, discovers a session on the bus, sends a prompt, and renders the reply", async () => {
    const id = await uniqueIdentity();
    const pass = await formatPass(id);
    const viewer = await Viewer.fromPass(pass, "http://broker", brokerFetch);
    const host = fakeHost(id);
    const sid = "sess-web";

    // The host announces the session on the bus; the viewer discovers it (decrypted under K_meta).
    await host.postFrame(
      header(id, { recordKind: "session_announce", sessionId: sid, msgId: "ann-w" }),
      utf8(
        JSON.stringify({
          session_id: sid,
          title: "web box",
          cwd: "/srv/app",
          sent_at: 1,
          mode: "plan",
        }),
      ),
    );
    const [discovered] = await takeGen(viewer.announces(never), 1);
    expect(discovered).toMatchObject({
      sessionId: sid,
      title: "web box",
      cwd: "/srv/app",
      mode: "plan",
    });

    // The viewer sends a prompt; the host receives it on the session channel and decrypts it.
    const text = "hello from the browser";
    await viewer.sendPrompt(sid, text);
    const [prompt] = await takeGen(host.streamFrames({ session: sid, startIndex: 0 }), 1);
    if (prompt === undefined) throw new Error("host saw no prompt");
    expect(prompt.dir).toBe("in");
    expect(prompt.recordKind).toBe("user");
    const got = new TextDecoder().decode(await host.openFrame(prompt));
    expect(got).toBe(text);

    // The host replies on the session out-stream; the viewer's transcript renders it in order.
    await host.postFrame(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "as-w" }),
      utf8(`you said: ${got}`),
    );
    await host.postFrame(
      header(id, { recordKind: "result", sessionId: sid, seq: 1, msgId: "re-w" }),
      utf8(JSON.stringify({ ok: true })),
    );
    const msgs = await takeGen(viewer.transcript(sid, never), 2);
    expect(msgs.map((m) => m.kind)).toEqual(["assistant", "result"]);
    expect(msgs[0]?.text).toBe("you said: hello from the browser");
  });

  it("reassembles a LARGE assistant message (split into chunks) through the viewer's reorder path", async () => {
    const id = await uniqueIdentity();
    const pass = await formatPass(id);
    const viewer = await Viewer.fromPass(pass, "http://broker", brokerFetch);
    const host = fakeHost(id);
    const sid = "big-view";
    // ~18 KB assistant reply, posted as chunks (8 KB) sharing one seq — the host's real path.
    const big = "lorem ipsum dolor ".repeat(1000);
    await host.postMessage(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "big-assistant" }),
      utf8(big),
      8000,
    );
    // The viewer must surface it as ONE message (FrameOrderer holds the seq until all parts land,
    // then openMessage reassembles) — not as fragments or a dropped tail.
    const [msg] = await takeGen(viewer.transcript(sid, never), 1);
    expect(msg?.kind).toBe("assistant");
    expect(msg?.text).toBe(big);
  });

  it("authenticates before ordering so a forged seq cannot hide the genuine frame", async () => {
    const id = await uniqueIdentity();
    const provider = securityProvider("sealed", id);
    const sid = "auth-before-order";
    const genuine0 = await provider.sealFrame(
      "session",
      header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "genuine-0" }),
      utf8("genuine zero"),
    );
    const forged0 = { ...genuine0, msgId: "forged-0", ct: genuine0.ct.slice() };
    forged0.ct[0] = (forged0.ct[0] ?? 0) ^ 0xff;
    const genuine1 = await provider.sealFrame(
      "session",
      header(id, { recordKind: "result", sessionId: sid, seq: 1, msgId: "genuine-1" }),
      utf8("genuine one"),
    );
    const stream = [forged0, genuine0, genuine1]
      .map((frame) => `data: ${JSON.stringify(encodeFrame(frame))}\n\n`)
      .join("");
    const fetchFn: typeof fetch = async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const viewer = await Viewer.fromPass(await formatPass(id), "http://faulty-broker", fetchFn);

    const messages = await takeGen(viewer.transcript(sid, never), 2);

    expect(messages.map(({ seq, text }) => [seq, text])).toEqual([
      [0, "genuine zero"],
      [1, "genuine one"],
    ]);
  });

  it("rejects a sibling session frame before it can consume this transcript's seq or msg id", async () => {
    const id = await uniqueIdentity();
    const provider = securityProvider("sealed", id);
    const selected = "selected-session";
    const sibling = "sibling-session";
    // Reuse both seq and msgId deliberately. A broker that routes the sibling frame first must not
    // poison either the order cursor or dedup state for the genuine selected-session frame.
    const siblingFrame = await provider.sealFrame(
      "session",
      header(id, {
        recordKind: "assistant",
        sessionId: sibling,
        seq: 0,
        msgId: "shared-coordinate",
      }),
      utf8("must never render"),
    );
    const selectedFrame = await provider.sealFrame(
      "session",
      header(id, {
        recordKind: "assistant",
        sessionId: selected,
        seq: 0,
        msgId: "shared-coordinate",
      }),
      utf8("selected session only"),
    );
    const stream = [siblingFrame, selectedFrame]
      .map((frame) => `data: ${JSON.stringify(encodeFrame(frame))}\n\n`)
      .join("");
    const fetchFn: typeof fetch = async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const viewer = await Viewer.fromPass(await formatPass(id), "http://faulty-broker", fetchFn);

    const [message] = await takeGen(viewer.transcript(selected, never), 1);

    expect(message).toMatchObject({ seq: 0, text: "selected session only" });
  });

  it("absorbs an exact terminal marker, removes it once, and rejects every later session mutation", async () => {
    const id = await uniqueIdentity();
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const host = fakeHost(id);
    const sid = "sess-terminal";
    const barrier = "sess-terminal-barrier";
    const terminals: string[] = [];
    const announces = viewer.announces(never, undefined, (sessionId) => terminals.push(sessionId));

    try {
      await host.postFrame(
        header(id, { recordKind: "session_announce", sessionId: sid, msgId: "ann-terminal" }),
        utf8(JSON.stringify({ session_id: sid, title: "closing", sent_at: 1 })),
      );
      expect((await announces.next()).value?.sessionId).toBe(sid);

      await host.postFrame(
        header(id, { recordKind: "session_terminal", sessionId: sid, msgId: `terminal-${sid}` }),
        utf8('{"v":1}'),
      );
      // A broker or reconnect may replay the same authenticated tombstone; the Viewer callback remains
      // edge-triggered and its internal session fence remains absorbing.
      await host.postFrame(
        header(id, {
          recordKind: "session_terminal",
          sessionId: sid,
          msgId: `terminal-${sid}`,
        }),
        utf8('{"v":1}'),
      );
      // A different session's announce is a deterministic read barrier: announces.next() cannot yield it
      // until it has consumed both earlier terminal records and invoked the lifecycle callback.
      await host.postFrame(
        header(id, {
          recordKind: "session_announce",
          sessionId: barrier,
          msgId: "terminal-barrier",
        }),
        utf8(JSON.stringify({ session_id: barrier, title: "barrier", sent_at: 2 })),
      );
      expect((await announces.next()).value?.sessionId).toBe(barrier);
      expect(terminals).toEqual([sid]);

      const rejected = [
        viewer.requestHistory(sid, 0),
        viewer.grantPermission(sid, "perm-1"),
        viewer.interrupt(sid),
        viewer.setModel(sid, "claude-opus-4-8"),
        viewer.setMode(sid, "plan"),
        viewer.endSession(sid),
        viewer.sendPrompt(sid, "must not publish"),
        viewer.command(sid, "/compact"),
        viewer.sendAttachment(sid, {
          images: [{ name: "x.png", mime: "image/png", data: "eA==" }],
        }),
      ];
      for (const mutation of rejected) {
        await expect(mutation).rejects.toBeInstanceOf(SessionTerminalError);
      }
    } finally {
      await announces.return(undefined);
    }
  });

  it("suppresses a late announce even when a faulty broker streams it after terminal", async () => {
    const id = await uniqueIdentity();
    const sid = "sess-late-after-terminal";
    const barrier = "sess-late-barrier";
    const provider = securityProvider("sealed", id);
    const frames = await Promise.all([
      provider.sealFrame(
        "meta",
        header(id, { recordKind: "session_announce", sessionId: sid, msgId: "ann-before" }),
        utf8(JSON.stringify({ session_id: sid, title: "before", sent_at: 1 })),
      ),
      provider.sealFrame(
        "meta",
        header(id, {
          recordKind: "session_terminal",
          sessionId: sid,
          msgId: `terminal-${sid}`,
        }),
        utf8('{"v":1}'),
      ),
      provider.sealFrame(
        "meta",
        header(id, { recordKind: "session_announce", sessionId: sid, msgId: "ann-after" }),
        utf8(JSON.stringify({ session_id: sid, title: "must not return", sent_at: 99 })),
      ),
      provider.sealFrame(
        "meta",
        header(id, { recordKind: "session_announce", sessionId: barrier, msgId: "ann-barrier" }),
        utf8(JSON.stringify({ session_id: barrier, title: "barrier", sent_at: 2 })),
      ),
    ]);
    const stream = frames
      .map((frame) => `data: ${JSON.stringify(encodeFrame(frame))}\n\n`)
      .join("");
    const fetchFn: typeof fetch = async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const viewer = await Viewer.fromPass(await formatPass(id), "http://faulty-broker", fetchFn);
    const terminals: string[] = [];

    const announces = await takeGen(
      viewer.announces(never, undefined, (sessionId) => terminals.push(sessionId)),
      2,
    );
    expect(announces.map((announce) => [announce.sessionId, announce.title])).toEqual([
      [sid, "before"],
      [barrier, "barrier"],
    ]);
    expect(terminals).toEqual([sid]);
    await expect(viewer.sendPrompt(sid, "still fenced")).rejects.toBeInstanceOf(
      SessionTerminalError,
    );
  });

  it("does not tombstone a session for a non-exact terminal payload", async () => {
    const id = await uniqueIdentity();
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const host = fakeHost(id);
    const sid = "sess-malformed-terminal";
    const barrier = "sess-malformed-barrier";
    const terminals: string[] = [];

    await host.postFrame(
      header(id, {
        recordKind: "session_terminal",
        sessionId: sid,
        msgId: `terminal-${sid}`,
      }),
      utf8('{"v":1,"extra":true}'),
    );
    await host.postFrame(
      header(id, { recordKind: "session_announce", sessionId: barrier, msgId: "barrier-ann" }),
      utf8(JSON.stringify({ session_id: barrier, title: "barrier", sent_at: 2 })),
    );
    const [barrierAnnounce] = await takeGen(
      viewer.announces(never, undefined, (sessionId) => terminals.push(sessionId)),
      1,
    );
    expect(barrierAnnounce?.sessionId).toBe(barrier);
    expect(terminals).toEqual([]);
    await expect(viewer.sendPrompt(sid, "still writable", "malformed-safe")).resolves.toBe(
      "malformed-safe",
    );
  });

  it("rejects a malformed pass with a clear error", async () => {
    await expect(Viewer.fromPass("not-a-pass", "http://broker", brokerFetch)).rejects.toThrow();
  });
});
