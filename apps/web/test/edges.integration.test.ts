// Edge-case integration suite. Uses the SAME transport library the host + web client use
// (@remote-claw/cli/broker: BrokerClient + FrameOrderer) against the REAL broker routes on the REAL
// Workflow runtime — so both sides are driven by the production code, not a mock. Covers the gnarly
// bits: reconnect/resume by startIndex, at-least-once dedup end to end, and the bus CAP-ROLL (the
// "window rolling over") teardown path.

import { busToken, type Frame, type Identity, utf8 } from "@remote-claw/clawsec";
import { BrokerClient, FrameOrderer, securityProvider } from "@remote-claw/cli/broker";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { getHookByToken, resumeHook } from "workflow/api";
import { brokerFetch, header, takeFrames } from "./e2e/harness";
import { uniqueIdentity } from "./helpers";

afterAll(async () => {
  await teardownWorkflowTests();
});

const td = new TextDecoder();

function clientFor(id: Identity): BrokerClient {
  return new BrokerClient({
    baseUrl: "https://broker",
    provider: securityProvider("sealed", id),
    fetchFn: brokerFetch,
  });
}

async function poll(pred: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("edge cases (same transport library, real Workflow runtime)", () => {
  it("RECONNECT: resume a session stream by startIndex picks up only frames at/after the cursor", async () => {
    const id = await uniqueIdentity();
    const c = clientFor(id);
    const sid = "reconnect";
    for (const n of [0, 1, 2]) {
      await c.postFrame(
        header(id, { recordKind: "assistant", sessionId: sid, seq: n, msgId: `m${n}` }),
        utf8(`f${n}`),
      );
    }
    // Fresh subscribe from 0 → all three, in order.
    const all = await takeFrames(
      c.streamFrames({ session: sid, startIndex: 0 }),
      3,
      (f) => f.dir === "out",
    );
    expect(all.map((f) => f.seq)).toEqual([0, 1, 2]);
    // Reconnect after a drop at seq 1 → resume at index 2 → only the tail.
    const tail = await takeFrames(
      c.streamFrames({ session: sid, startIndex: 2 }),
      1,
      (f) => f.dir === "out",
    );
    expect(tail.map((f) => f.seq)).toEqual([2]);
    expect(td.decode(await c.openFrame(tail[0] as Frame))).toBe("f2");
  });

  it("DEDUP: a frame replayed by the at-least-once broker is delivered once by the viewer", async () => {
    const id = await uniqueIdentity();
    const c = clientFor(id);
    const sid = "dedup";
    const h = header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "dup-1" });
    // The same logical frame arrives twice (resend / at-least-once).
    await c.postFrame(h, utf8("once"));
    await c.postFrame(h, utf8("once"));
    const raw = await takeFrames(
      c.streamFrames({ session: sid, startIndex: 0 }),
      2,
      (f) => f.dir === "out",
    );
    expect(raw).toHaveLength(2); // the broker faithfully streamed both copies...
    const orderer = new FrameOrderer();
    const delivered = raw.flatMap((f) => orderer.accept(f));
    expect(delivered).toHaveLength(1); // ...but the viewer's discipline collapses them to one.
    expect(td.decode(await c.openFrame(delivered[0] as Frame))).toBe("once");
  });

  it("LARGE MESSAGE: a plaintext over the chunk limit splits, flows, and reassembles end to end", async () => {
    const id = await uniqueIdentity();
    const c = clientFor(id);
    const sid = "big";
    // 20 KB message, 8 KB chunk limit → 3 independently-AEAD'd parts sharing one msg_id.
    const big = new Uint8Array(20_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251;
    const results = await c.postMessage(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "big-1" }),
      big,
      8_000,
    );
    expect(results).toHaveLength(3);

    const parts = await takeFrames(
      c.streamFrames({ session: sid, startIndex: 0 }),
      3,
      (f) => f.dir === "out",
    );
    expect(parts.map((f) => f.part).sort()).toEqual([0, 1, 2]);
    expect(await c.openMessage(parts)).toEqual(big); // full plaintext reassembled

    // A tampered chunk fails AEAD on reassembly — never corrupts the buffer.
    const tampered = parts.map((f) =>
      f.part === 1 ? { ...f, ct: Uint8Array.from(f.ct, (b, i) => (i === 0 ? b ^ 0xff : b)) } : f,
    );
    await expect(c.openMessage(tampered as Frame[])).rejects.toThrow();
  });

  it("CAP-ROLL: __close completes the bus run, frees the 1:1 token, and a fresh run re-creates it", async () => {
    const id = await uniqueIdentity();
    const c = clientFor(id);
    const token = busToken(id.identityId);
    const announce = (n: number) =>
      c.postFrame(
        header(id, { recordKind: "session_announce", sessionId: `s${n}`, msgId: `ann-${n}` }),
        utf8(JSON.stringify({ session_id: `s${n}`, sent_at: n })),
      );

    // Create the bus run; the derived token resolves.
    await announce(1);
    expect(
      await poll(
        async () =>
          await getHookByToken(token)
            .then(() => true)
            .catch(() => false),
      ),
    ).toBe(true);

    // Roll it: the cap-roll completes the run (closes its stream, disposes the hook → frees the token).
    await resumeHook(token, { __close: true });
    const freed = await poll(async () =>
      getHookByToken(token)
        .then(() => false)
        .catch(() => true),
    );
    expect(freed).toBe(true); // HookNotFound — the 1:1 token is free

    // A fresh publish re-`start()`s a NEW run under the same token (the handoff).
    const res = await announce(2);
    expect(res.created).toBe(true);
    expect(
      await poll(async () =>
        getHookByToken(token)
          .then(() => true)
          .catch(() => false),
      ),
    ).toBe(true);
  });

  it("MULTI-CLIENT: two devices on one identity concurrently tail the same session, both see the whole timeline", async () => {
    // Several devices hold the SAME secret and subscribe to the same session out-stream. The broker
    // fans every frame out to each subscriber independently, so both reconstruct a byte-identical
    // transcript — including a chunked (large) message that each must reassemble on its own.
    const id = await uniqueIdentity();
    const phone = clientFor(id);
    const laptop = clientFor(id);
    const sid = "fanout";

    const big = new Uint8Array(20_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13) % 251;
    // Host emits: assistant (seq 0), a large chunked assistant (seq 1), result (seq 2).
    await phone.postFrame(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "a0" }),
      utf8("first"),
    );
    await phone.postMessage(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 1, msgId: "a1-big" }),
      big,
      8_000,
    );
    await phone.postFrame(
      header(id, { recordKind: "result", sessionId: sid, seq: 2, msgId: "r0" }),
      utf8("done"),
    );

    // Both devices subscribe CONCURRENTLY from 0 and reconstruct the identical timeline — using the
    // same dedup+reorder discipline the real viewer runs (FrameOrderer → openFrame/openMessage).
    const drain = async (c: BrokerClient) => {
      const orderer = new FrameOrderer();
      const seqs: number[] = [];
      let bigOut: Uint8Array | null = null;
      // 5 wire frames: a0, three parts of a1-big, r0.
      const raw = await takeFrames(
        c.streamFrames({ session: sid, startIndex: 0 }),
        5,
        (f) => f.dir === "out",
      );
      for (const f of raw) {
        const ready = orderer.accept(f);
        for (let i = 0; i < ready.length; ) {
          const rf = ready[i] as Frame;
          const span = rf.parts > 1 ? rf.parts : 1;
          const group = ready.slice(i, i + span);
          i += span;
          if (span > 1) bigOut = await c.openMessage(group);
          else await c.openFrame(rf);
          seqs.push(rf.seq as number);
        }
      }
      return { seqs, bigOut };
    };
    const [a, b] = await Promise.all([drain(phone), drain(laptop)]);
    expect(a.seqs).toEqual([0, 1, 2]);
    expect(b.seqs).toEqual([0, 1, 2]);
    expect(a.bigOut).toEqual(big);
    expect(b.bigOut).toEqual(big); // independent reassembly, identical bytes
  });

  it("DROP + RECONNECT: a viewer that disconnects resumes from its cursor with no gap and no dup", async () => {
    const id = await uniqueIdentity();
    const c = clientFor(id);
    const sid = "drop";
    const orderer = new FrameOrderer();
    const got: number[] = [];
    const consume = (frames: Frame[]) => {
      for (const f of frames)
        for (const d of orderer.accept(f)) if (d.seq !== null) got.push(d.seq);
    };
    const postN = (n: number) =>
      c.postFrame(
        header(id, { recordKind: "assistant", sessionId: sid, seq: n, msgId: `m${n}` }),
        utf8(`f${n}`),
      );

    // First connection: read seqs 0,1.
    await postN(0);
    await postN(1);
    consume(
      await takeFrames(c.streamFrames({ session: sid, startIndex: 0 }), 2, (f) => f.dir === "out"),
    );
    expect(got).toEqual([0, 1]);

    // The viewer DROPS; time passes; the host keeps producing 2,3.
    await new Promise((r) => setTimeout(r, 300));
    await postN(2);
    await postN(3);

    // Reconnect: resume from the orderer's cursor (the catch_up `since`). A full re-read from 0 would
    // also be safe — the orderer dedups already-delivered seqs — but resuming from the cursor is the
    // efficient protocol. No gap, no duplicate across the reconnect.
    consume(
      await takeFrames(
        c.streamFrames({ session: sid, startIndex: orderer.nextSeq }),
        2,
        (f) => f.dir === "out",
      ),
    );
    expect(got).toEqual([0, 1, 2, 3]);
  });
});
