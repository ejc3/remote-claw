import {
  deriveIdentity,
  type Frame,
  type FrameHeader,
  type Identity,
  utf8,
} from "@remote-claw/clawsec";
import { describe, expect, it, vi } from "vitest";
import { BrokerClient } from "../broker/client.js";
import { MockBroker } from "../broker/mockbroker.js";
import { FrameOrderer } from "../broker/order.js";
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

function userFrame(id: Identity, sid: string, msgId: string, clientMsgId = "c1"): FrameHeader {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId: sid,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId,
    clientMsgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
  };
}

function catchUpFrame(id: Identity, sid: string, msgId: string): FrameHeader {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId: sid,
    dir: "in",
    recordKind: "catch_up",
    seq: null,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
  };
}

/** Finite inbound transport using the real sealed provider. Outbound writes are captured because
 *  these tests target receive admission, not the already-covered BrokerClient publish path. */
class SealedLegacyClient {
  readonly opened: string[] = [];
  readonly outbound: Array<{ header: FrameHeader; body: Uint8Array }> = [];

  constructor(
    readonly provider: ReturnType<typeof securityProvider>,
    readonly inbound: Frame[],
  ) {}

  async *streamFrames(): AsyncGenerator<Frame> {
    for (const frame of this.inbound) yield frame;
  }

  openFrame(frame: Frame): Promise<Uint8Array> {
    this.opened.push(frame.msgId);
    return this.provider.openFrame("session", frame);
  }

  postMessage(header: FrameHeader, body: Uint8Array): Promise<[]> {
    this.outbound.push({ header, body });
    return Promise.resolve([]);
  }
}

async function outFrames(viewer: BrokerClient, sid: string, count: number): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const f of viewer.streamFrames({ session: sid, startIndex: 0 })) {
    if (f.dir === "out") out.push(f);
    if (out.length === count) return out;
  }
  throw new Error(`stream ended before ${count} outbound frame(s)`);
}

async function serveAndCollect(
  relay: HostRelay,
  viewer: BrokerClient,
  sid: string,
  count: number,
): Promise<Frame[]> {
  const owner = new AbortController();
  const served = relay.serve(owner.signal);
  const out = await outFrames(viewer, sid, count);
  owner.abort();
  await served;
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
    const out = await serveAndCollect(relay, viewer, sid, 4);
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
    const out = await serveAndCollect(relay, viewer, sid, 4);
    // Exactly one turn relayed, not two.
    expect(out.filter((f) => f.recordKind === "assistant")).toHaveLength(1);
    expect(out.map((f) => f.recordKind)).toEqual(["accepted", "user", "assistant", "result"]);
  });

  it("replays the transcript on a catch_up control frame (history sync)", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(7));
    const broker = new MockBroker();
    const host = client(id, broker);
    const viewer = client(id, broker);
    const sid = "s3";

    // One turn happens, THEN a late viewer asks for the whole history from seq 0.
    await viewer.postFrame(userFrame(id, sid, "u1"), utf8("hello"));
    await viewer.postFrame(catchUpFrame(id, sid, "cu1"), utf8(JSON.stringify({ since: 0 })));
    const relay = new HostRelay({
      client: host,
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });
    const out = await serveAndCollect(relay, viewer, sid, 7);
    // The original turn (accepted + user/assistant/result) plus a replay of the 3 content frames.
    // The accepted ack is meta (not logged), so it is NOT replayed.
    expect(out.map((f) => f.recordKind)).toEqual([
      "accepted",
      "user",
      "assistant",
      "result",
      "user",
      "assistant",
      "result",
    ]);
    // Each replayed content frame reuses its original seq + msg_id, so the viewer's orderer dedups it.
    const content = out.filter((f) => f.seq !== null);
    const orderer = new FrameOrderer();
    const delivered = content.flatMap((f) => orderer.accept(f));
    expect(delivered.map((f) => f.seq)).toEqual([0, 1, 2]); // 6 frames in, 3 unique out
  });

  it("serves two devices on one identity: both prompts run, both viewers see the same timeline", async () => {
    // "Multi-client" = several devices holding the SAME secret, all on the session channel. Each posts
    // its own prompt (distinct client_msg_id + msg_id); the host relays both turns on one shared seq
    // timeline, and every subscriber reconstructs the identical transcript.
    const id = await deriveIdentity(new Uint8Array(32).fill(9));
    const broker = new MockBroker();
    const host = client(id, broker);
    const phone = client(id, broker);
    const laptop = client(id, broker);
    const sid = "multi";

    await phone.postFrame(userFrame(id, sid, "phone-1", "phone-c1"), utf8("from phone"));
    await laptop.postFrame(userFrame(id, sid, "laptop-1", "laptop-c1"), utf8("from laptop"));
    const relay = new HostRelay({
      client: host,
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });
    const owner = new AbortController();
    const served = relay.serve(owner.signal);

    // Two full turns on a single shared timeline, in arrival order.
    const expectKinds = [
      "accepted",
      "user",
      "assistant",
      "result",
      "accepted",
      "user",
      "assistant",
      "result",
    ];
    // BOTH devices, reading the same out-stream, see byte-identical transcripts.
    for (const viewer of [phone, laptop]) {
      const out = await outFrames(viewer, sid, 8);
      expect(out.map((f) => f.recordKind)).toEqual(expectKinds);
      const orderer = new FrameOrderer();
      const content = out.filter((f) => f.seq !== null).flatMap((f) => orderer.accept(f));
      expect(content.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4, 5]); // one shared, gap-free timeline
      const text = async (f: Frame) => td.decode(await viewer.openFrame(f));
      expect(await text(content[0] as Frame)).toBe("from phone");
      expect(await text(content[1] as Frame)).toBe("echo: from phone");
      expect(await text(content[3] as Frame)).toBe("from laptop");
      expect(await text(content[4] as Frame)).toBe("echo: from laptop");
    }
    // Each device's accepted ack carries ITS OWN client_msg_id, so each can match its own send.
    const out = await outFrames(phone, sid, 8);
    const acks = out.filter((f) => f.recordKind === "accepted");
    const ackIds = await Promise.all(
      acks.map(async (f) => JSON.parse(td.decode(await phone.openFrame(f))).client_msg_id),
    );
    expect(ackIds).toEqual(["phone-c1", "laptop-c1"]);
    owner.abort();
    await served;
  });

  it("multi-client with mixed catch_ups: each late device gets exactly the tail it's missing", async () => {
    // Several devices on one identity: one drives turns, others join late and ask for replays from
    // DIFFERENT points. The host replays from each `since`; every viewer's orderer dedups overlaps, so
    // a device that already has a prefix re-syncs cleanly while a fresh device gets the whole history.
    const id = await deriveIdentity(new Uint8Array(32).fill(10));
    const broker = new MockBroker();
    const host = client(id, broker);
    const driver = client(id, broker);
    const sid = "replays";

    // Turn 1 (seqs 0,1,2), then a fresh device asks for everything; turn 2 (seqs 3,4,5), then a device
    // that already saw turn 1 asks only for the tail from seq 3.
    await driver.postFrame(userFrame(id, sid, "d-1", "d-c1"), utf8("one"));
    await driver.postFrame(catchUpFrame(id, sid, "cu-full"), utf8(JSON.stringify({ since: 0 })));
    await driver.postFrame(userFrame(id, sid, "d-2", "d-c2"), utf8("two"));
    await driver.postFrame(catchUpFrame(id, sid, "cu-tail"), utf8(JSON.stringify({ since: 3 })));
    const relay = new HostRelay({
      client: host,
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });
    const out = await serveAndCollect(relay, driver, sid, 14);
    // Two real turns + a full replay (3 frames) after turn 1 + a tail replay (3 frames) after turn 2.
    expect(out.filter((f) => f.recordKind === "accepted")).toHaveLength(2);
    expect(out.filter((f) => f.seq !== null)).toHaveLength(2 * 3 + 3 + 3); // 6 live + 6 replayed

    // A device that joins fresh and reads the whole stream dedups every replayed frame → 6 unique seqs.
    const fresh = new FrameOrderer();
    const delivered = out.filter((f) => f.seq !== null).flatMap((f) => fresh.accept(f));
    expect(delivered.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fresh.nextSeq).toBe(6);
  });

  it("a catch_up with since past the tail replays nothing (no error)", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(8));
    const broker = new MockBroker();
    const host = client(id, broker);
    const viewer = client(id, broker);
    const sid = "s4";

    await viewer.postFrame(userFrame(id, sid, "u1"), utf8("hello"));
    await viewer.postFrame(catchUpFrame(id, sid, "cu1"), utf8(JSON.stringify({ since: 99 })));
    const relay = new HostRelay({
      client: host,
      identityId: id.identityId,
      sessionId: sid,
      backend: fakeBackend(),
    });
    const out = await serveAndCollect(relay, viewer, sid, 4);
    // Just the original turn — nothing at/after seq 99 to replay.
    expect(out.map((f) => f.recordKind)).toEqual(["accepted", "user", "assistant", "result"]);
  });
});

describe("HostRelay hostile broker admission", () => {
  it("fences validly sealed sibling-session and wrong-identity frames before open or dedup", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(44));
    const provider = securityProvider("sealed", identity);
    const sessionA = "legacy-session-a";
    const sessionB = "legacy-session-b";
    const msgId = "shared-coordinate-id";
    const header = (sessionId: string, identityId = identity.identityId): FrameHeader => ({
      v: 1,
      identityId,
      sessionId,
      dir: "in",
      recordKind: "user",
      seq: null,
      msgId,
      keyEpoch: 0,
      part: 0,
      parts: 1,
    });
    const sibling = await provider.sealFrame(
      "session",
      header(sessionB),
      utf8("command for sibling"),
    );
    const wrongIdentity = await provider.sealFrame(
      "session",
      header(sessionA, new Uint8Array(identity.identityId.length).fill(0xff)),
      utf8("command under wrong identity coordinate"),
    );
    const selected = await provider.sealFrame(
      "session",
      header(sessionA),
      utf8("command for selected session"),
    );
    const sealedClient = new SealedLegacyClient(provider, [sibling, wrongIdentity, selected]);
    const backend = fakeBackend();
    const prompt = vi.spyOn(backend, "prompt");
    const relay = new HostRelay({
      client: sealedClient as unknown as BrokerClient,
      identityId: identity.identityId,
      sessionId: sessionA,
      backend,
    });

    await relay.serve(new AbortController().signal);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("command for selected session");
    // Only the exact selected coordinate reached AEAD open; neither rejected frame poisoned msgId.
    expect(sealedClient.opened).toEqual([msgId]);
  });

  it("authenticates before dedup so tampered ciphertext cannot suppress a genuine command", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(45));
    const provider = securityProvider("sealed", identity);
    const sid = "legacy-auth-order";
    const header = userFrame(identity, sid, "visible-shared-msg-id");
    const genuine = await provider.sealFrame("session", header, utf8("genuine legacy command"));
    const forged = { ...genuine, ct: genuine.ct.slice() };
    forged.ct[0] = (forged.ct[0] ?? 0) ^ 1;
    const sealedClient = new SealedLegacyClient(provider, [forged, genuine]);
    const backend = fakeBackend();
    const prompt = vi.spyOn(backend, "prompt");
    const relay = new HostRelay({
      client: sealedClient as unknown as BrokerClient,
      identityId: identity.identityId,
      sessionId: sid,
      backend,
    });

    await relay.serve(new AbortController().signal);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("genuine legacy command");
    expect(sealedClient.opened).toEqual([header.msgId, header.msgId]);
  });
});
