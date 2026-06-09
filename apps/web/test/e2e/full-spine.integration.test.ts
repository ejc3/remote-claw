// FULL-SPINE e2e: the REAL HostRelay.serve() loop driving a deterministic fake backend, talking to
// the REAL broker routes on the REAL Workflow runtime (in-process via @workflow/vitest), with the
// REAL browser Viewer on the other side. No MockBroker, no hand-posted host frames — serve() tails a
// LIVE SSE stream and relays each turn exactly as production does. The only fake is "claude" (a
// scripted backend) so CI stays deterministic and needs no logged-in claude. This is the no-shortcuts
// proof that the whole pipe — seal → POST /api/relay → relay run → out-stream → SSE → open — carries
// turns, history replay (catch_up), and multiple concurrent devices end to end.

import { deriveIdentity, formatPass, type Identity } from "@remote-claw/clawsec";
import {
  BrokerClient,
  type ClaudeBackend,
  HostRelay,
  securityProvider,
  type TurnEvent,
} from "@remote-claw/cli";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { type Message, Viewer } from "../../app/lib/viewer";
import { brokerFetch } from "./harness";

afterAll(async () => {
  await teardownWorkflowTests();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await sleep(50);
  if (!pred()) throw new Error("timed out waiting for a condition");
}

/** A deterministic fake claude: one assistant line echoing the prompt, then a result. */
function fakeBackend(): ClaudeBackend {
  return {
    async *prompt(text: string): AsyncIterable<TurnEvent> {
      yield { kind: "assistant", text: `echo: ${text}` };
      yield { kind: "result", text: JSON.stringify({ ok: true }) };
    },
    async close() {},
  };
}

function hostClient(id: Identity): BrokerClient {
  return new BrokerClient({
    baseUrl: "http://broker",
    provider: securityProvider("sealed", id),
    fetchFn: brokerFetch,
  });
}

/** Tail a viewer's transcript into `sink` until aborted (swallows the abort). */
function tailInto(viewer: Viewer, sid: string, sink: Message[], signal: AbortSignal): void {
  void (async () => {
    for await (const m of viewer.transcript(sid, signal)) sink.push(m);
  })().catch(() => {});
}

describe("full-spine e2e (real serve loop, real Workflow runtime, fake backend)", () => {
  it("relays a live turn through the real serve() loop end to end", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(40));
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const sid = "spine-1";
    const relay = new HostRelay({
      client: hostClient(id),
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });

    // The viewer's prompt creates the session run; the host then serves the live stream.
    await viewer.sendPrompt(sid, "hello spine");
    const serveAc = new AbortController();
    void relay.serve(serveAc.signal).catch(() => {});

    const got: Message[] = [];
    const txAc = new AbortController();
    tailInto(viewer, sid, got, txAc.signal);

    await waitFor(() => got.some((m) => m.kind === "result"));
    serveAc.abort();
    txAc.abort();

    // The viewer rendered exactly one full turn: the echo of its prompt, the assistant, the result.
    expect(got.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(["hello spine"]);
    expect(got.filter((m) => m.kind === "assistant").map((m) => m.text)).toEqual([
      "echo: hello spine",
    ]);
    expect(got.filter((m) => m.kind === "result")).toHaveLength(1);
    // Content seqs are gap-free from 0 (the orderer would have withheld a gap).
    expect(got.filter((m) => m.seq !== null).map((m) => m.seq)).toEqual([0, 1, 2]);
  }, 30_000);

  it("CATCH_UP: a late viewer requests history and the live host replays the transcript", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(41));
    const driver = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const sid = "spine-catchup";
    const relay = new HostRelay({
      client: hostClient(id),
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });

    await driver.sendPrompt(sid, "remember me");
    const serveAc = new AbortController();
    void relay.serve(serveAc.signal).catch(() => {});

    // The driver waits for turn 1 to finish (so the host's transcript log has 3 entries).
    const driverMsgs: Message[] = [];
    const dAc = new AbortController();
    tailInto(driver, sid, driverMsgs, dAc.signal);
    await waitFor(() => driverMsgs.some((m) => m.kind === "result"));

    // A SECOND device joins fresh and asks the live host to replay history from seq 0.
    const late = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const lateMsgs: Message[] = [];
    const lAc = new AbortController();
    tailInto(late, sid, lateMsgs, lAc.signal);
    await late.requestHistory(sid, 0);

    // The host replays user/assistant/result; the late viewer reconstructs the whole turn.
    await waitFor(() => lateMsgs.some((m) => m.kind === "result"));
    serveAc.abort();
    dAc.abort();
    lAc.abort();

    expect(lateMsgs.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(["remember me"]);
    expect(lateMsgs.filter((m) => m.kind === "assistant").map((m) => m.text)).toEqual([
      "echo: remember me",
    ]);
    // Even though replay frames reuse seqs the live stream already carried, the orderer dedups, so the
    // late viewer sees each transcript entry exactly once.
    expect(lateMsgs.filter((m) => m.seq !== null).map((m) => m.seq)).toEqual([0, 1, 2]);
  }, 30_000);

  it("MULTI-CLIENT: two devices both drive turns on one identity; both see the shared timeline", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(42));
    const phone = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const laptop = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const sid = "spine-multi";
    const relay = new HostRelay({
      client: hostClient(id),
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });

    // The phone opens the session; the host serves; both devices tail the same transcript.
    await phone.sendPrompt(sid, "from phone");
    const serveAc = new AbortController();
    void relay.serve(serveAc.signal).catch(() => {});

    const phoneMsgs: Message[] = [];
    const laptopMsgs: Message[] = [];
    const pAc = new AbortController();
    const lAc = new AbortController();
    tailInto(phone, sid, phoneMsgs, pAc.signal);
    tailInto(laptop, sid, laptopMsgs, lAc.signal);

    // Turn 1 (phone) lands, then the laptop drives turn 2 on the SAME session.
    await waitFor(() => phoneMsgs.some((m) => m.kind === "result"));
    await laptop.sendPrompt(sid, "from laptop");
    const twoTurns = (ms: Message[]) => ms.filter((m) => m.kind === "result").length >= 2;
    await waitFor(() => twoTurns(phoneMsgs) && twoTurns(laptopMsgs));
    serveAc.abort();
    pAc.abort();
    lAc.abort();

    // BOTH devices reconstructed the identical, gap-free shared timeline (6 content frames, seqs 0..5).
    for (const msgs of [phoneMsgs, laptopMsgs]) {
      expect(msgs.filter((m) => m.seq !== null).map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(msgs.filter((m) => m.kind === "user").map((m) => m.text)).toEqual([
        "from phone",
        "from laptop",
      ]);
      expect(msgs.filter((m) => m.kind === "assistant").map((m) => m.text)).toEqual([
        "echo: from phone",
        "echo: from laptop",
      ]);
    }
  }, 30_000);
});
