import { type Frame, type Identity, utf8 } from "@remote-claw/clawsec";
import { BrokerClient, FrameOrderer, securityProvider } from "@remote-claw/cli";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { brokerFetch, fakeClaudeReply, header, takeFrames } from "./e2e/harness";
import { uniqueIdentity } from "./helpers";

afterAll(async () => {
  await teardownWorkflowTests();
});

const td = new TextDecoder();

/** A host and a viewer for one machine — same derived keys (the viewer holds the pass); roles differ. */
function pair(id: Identity): { host: BrokerClient; viewer: BrokerClient } {
  const make = () =>
    new BrokerClient({
      baseUrl: "http://broker",
      provider: securityProvider("sealed", id),
      fetchFn: brokerFetch,
    });
  return { host: make(), viewer: make() };
}

describe("end-to-end: host ↔ broker ↔ viewer (real crypto + real Workflow runtime)", () => {
  it("discovers a session on the bus, then completes an encrypted prompt → response turn", async () => {
    const id = await uniqueIdentity();
    const { host, viewer } = pair(id);
    const sid = "sess-1";

    // 1) Discovery — the host broadcasts a session_announce on the bus; the viewer tails it and
    //    decrypts it under K_meta (the broker only saw ciphertext).
    await host.postFrame(
      header(id, { recordKind: "session_announce", sessionId: sid, msgId: "ann-1" }),
      utf8(JSON.stringify({ session_id: sid, title: "dev box", sent_at: 1000 })),
    );
    const [announce] = await takeFrames(viewer.streamFrames({ startIndex: 0 }), 1);
    if (announce === undefined) throw new Error("viewer saw no announce");
    expect(JSON.parse(td.decode(await viewer.openFrame(announce)))).toMatchObject({
      title: "dev box",
    });

    // 2) Prompt — the viewer sends a `user` content frame (dir:in, K_session) on the session channel.
    const prompt = "what is 2+2?";
    await viewer.postFrame(
      header(id, {
        recordKind: "user",
        dir: "in",
        sessionId: sid,
        msgId: "u-1",
        clientMsgId: "c-1",
      }),
      utf8(prompt),
    );

    // 3) The host receives it (filters dir:in), decrypts, runs fake claude, and emits the turn:
    //    accepted (meta ack) + user echo (seq 0) + assistant (seq 1) + result (seq 2), all dir:out.
    const [userIn] = await takeFrames(
      host.streamFrames({ session: sid, startIndex: 0 }),
      1,
      (f) => f.dir === "in",
    );
    if (userIn === undefined) throw new Error("host saw no inbound prompt");
    const got = td.decode(await host.openFrame(userIn));
    expect(got).toBe(prompt);
    const reply = fakeClaudeReply(got);

    await host.postFrame(
      header(id, { recordKind: "accepted", sessionId: sid, msgId: "ack-1" }),
      utf8(JSON.stringify({ client_msg_id: "c-1", seq: 0 })),
    );
    await host.postFrame(
      header(id, { recordKind: "user", sessionId: sid, seq: 0, msgId: "ue-1" }),
      utf8(got),
    );
    await host.postFrame(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 1, msgId: "as-1" }),
      utf8(reply),
    );
    await host.postFrame(
      header(id, { recordKind: "result", sessionId: sid, seq: 2, msgId: "re-1" }),
      utf8(JSON.stringify({ ok: true })),
    );

    // 4) The viewer reads the out-frames, runs them through the at-least-once/reorder discipline,
    //    and decrypts each under the right key.
    const out = await takeFrames(
      viewer.streamFrames({ session: sid, startIndex: 0 }),
      4,
      (f) => f.dir === "out",
    );
    const orderer = new FrameOrderer();
    const delivered: Frame[] = [];
    for (const f of out) delivered.push(...orderer.accept(f));

    const accepted = delivered.find((f) => f.recordKind === "accepted");
    if (accepted === undefined) throw new Error("no accepted ack");
    expect(JSON.parse(td.decode(await viewer.openFrame(accepted)))).toMatchObject({
      client_msg_id: "c-1",
    });

    const content = delivered.filter((f) => f.seq !== null);
    expect(content.map((f) => f.seq)).toEqual([0, 1, 2]); // reordered into transcript order
    const texts = await Promise.all(content.map(async (f) => td.decode(await viewer.openFrame(f))));
    expect(texts[0]).toBe(prompt); // the user echo
    expect(texts[1]).toBe("you said: what is 2+2?"); // the assistant reply (fake claude)
    expect(JSON.parse(texts[2] ?? "{}")).toMatchObject({ ok: true }); // the result
  });

  it("carries a control frame (interrupt) on the session channel under control_key", async () => {
    const id = await uniqueIdentity();
    const { host, viewer } = pair(id);
    const sid = "sess-ctl";

    await viewer.postFrame(
      header(id, { recordKind: "interrupt", dir: "in", sessionId: sid, msgId: "int-1" }),
      utf8(JSON.stringify({ expiry: 9_999_999_999 })),
    );
    const [ctl] = await takeFrames(
      host.streamFrames({ session: sid, startIndex: 0 }),
      1,
      (f) => f.dir === "in",
    );
    if (ctl === undefined) throw new Error("host saw no control frame");
    expect(ctl.recordKind).toBe("interrupt");
    // Opens only under control_key (a wrong plane would throw) — proves the control plane round-trips.
    expect(JSON.parse(td.decode(await host.openFrame(ctl)))).toMatchObject({
      expiry: 9_999_999_999,
    });
  });
});
