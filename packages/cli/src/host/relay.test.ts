import {
  deriveIdentity,
  type Frame,
  type FrameHeader,
  type Identity,
  utf8,
} from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { BrokerClient } from "../broker/client.js";
import { MockBroker } from "../broker/mockbroker.js";
import { securityProvider } from "../security/provider.js";
import type { ClaudeBackend, TurnEvent } from "./claude.js";
import { HostRelay } from "./relay.js";

const td = new TextDecoder();

/** A deterministic fake claude: one assistant line + a result, echoing the prompt. */
function fakeBackend(): ClaudeBackend {
  return {
    async *prompt(text: string): AsyncIterable<TurnEvent> {
      yield { kind: "assistant", text: `echo: ${text}` };
      yield { kind: "result", text: JSON.stringify({ ok: true }) };
    },
    async close() {},
  };
}

function client(id: Identity, broker: MockBroker): BrokerClient {
  return new BrokerClient({
    baseUrl: "http://b",
    provider: securityProvider("sealed", id),
    fetchFn: broker.fetch,
  });
}

function userFrame(id: Identity, sid: string, msgId: string): FrameHeader {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId: sid,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId,
    clientMsgId: "c1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
  };
}

async function outFrames(viewer: BrokerClient, sid: string): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const f of viewer.streamFrames({ session: sid, startIndex: 0 })) {
    if (f.dir === "out") out.push(f);
  }
  return out;
}

describe("HostRelay (fake backend, mock broker)", () => {
  it("acks, echoes, and relays a turn for an inbound user prompt", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(5));
    const broker = new MockBroker();
    const host = client(id, broker);
    const viewer = client(id, broker);
    const sid = "s1";

    await viewer.postFrame(userFrame(id, sid, "u1"), utf8("hi there"));
    const relay = new HostRelay({
      client: host,
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });
    await relay.serve(new AbortController().signal); // mock stream is finite → returns after the turn

    const out = await outFrames(viewer, sid);
    expect(out.map((f) => f.recordKind)).toEqual(["accepted", "user", "assistant", "result"]);
    const text = async (f: Frame) => td.decode(await viewer.openFrame(f));
    expect(JSON.parse(await text(out[0] as Frame)).client_msg_id).toBe("c1"); // accepted ack
    expect(await text(out[1] as Frame)).toBe("hi there"); // user echo
    expect(await text(out[2] as Frame)).toBe("echo: hi there"); // assistant
    expect(JSON.parse(await text(out[3] as Frame)).ok).toBe(true); // result
    // content frames carry consecutive seqs (the echo gets 0).
    expect(out.filter((f) => f.seq !== null).map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  it("dedups a replayed inbound prompt (same msg_id → one turn)", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(6));
    const broker = new MockBroker();
    const host = client(id, broker);
    const viewer = client(id, broker);
    const sid = "s2";

    // The same frame arrives twice (at-least-once delivery).
    await viewer.postFrame(userFrame(id, sid, "dup"), utf8("once"));
    await viewer.postFrame(userFrame(id, sid, "dup"), utf8("once"));
    const relay = new HostRelay({
      client: host,
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });
    await relay.serve(new AbortController().signal);

    const out = await outFrames(viewer, sid);
    // Exactly one turn relayed, not two.
    expect(out.filter((f) => f.recordKind === "assistant")).toHaveLength(1);
    expect(out.map((f) => f.recordKind)).toEqual(["accepted", "user", "assistant", "result"]);
  });
});
