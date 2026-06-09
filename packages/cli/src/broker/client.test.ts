import { deriveIdentity, type FrameHeader, type Identity, utf8 } from "@remote-claw/clawsec";
import { beforeEach, describe, expect, it } from "vitest";
import { securityProvider } from "../security/provider.js";
import { BrokerClient, BrokerError } from "./client.js";
import { MockBroker } from "./mockbroker.js";

const td = new TextDecoder();

function header(id: Identity, extra: Partial<FrameHeader> = {}): FrameHeader {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId: "sess-1",
    dir: "out",
    recordKind: "session_announce",
    seq: null,
    msgId: "m1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...extra,
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("BrokerClient transport", () => {
  let id: Identity;
  let broker: MockBroker;
  let client: BrokerClient;

  beforeEach(async () => {
    id = await deriveIdentity(new Uint8Array(32).fill(7));
    broker = new MockBroker();
    client = new BrokerClient({
      baseUrl: "http://broker.test/",
      provider: securityProvider("sealed", id),
      fetchFn: broker.fetch,
    });
  });

  it("round-trips a sealed announce on the BUS: post → stream → open", async () => {
    const sent = { session_id: "sess-1", title: "laptop", sent_at: 1 };
    const res = await client.postFrame(header(id), utf8(JSON.stringify(sent)));
    expect(res).toMatchObject({ ok: true, channel: "bus" });
    expect(broker.posts[0]?.channel).toBe("bus"); // session_announce routed to the bus, no ?session
    expect(broker.posts[0]?.session).toBeNull();

    const [frame] = await collect(client.streamFrames({}));
    expect(frame).toBeDefined();
    if (frame === undefined) throw new Error("no frame");
    expect(JSON.parse(td.decode(await client.openFrame(frame)))).toMatchObject({ title: "laptop" });
  });

  it("round-trips a content frame on the SESSION channel and tags ?session", async () => {
    const h = header(id, { recordKind: "assistant", seq: 0, sessionId: "sX" });
    await client.postFrame(h, utf8("hello from claude"));
    expect(broker.posts[0]?.channel).toBe("session");
    expect(broker.posts[0]?.session).toBe("sX");

    const [frame] = await collect(client.streamFrames({ session: "sX" }));
    if (frame === undefined) throw new Error("no frame");
    expect(td.decode(await client.openFrame(frame))).toBe("hello from claude");
  });

  it("sends Authorization: Bearer <hex(auth_token)> on every call", async () => {
    broker.requireAuth(id.authToken);
    await expect(client.postFrame(header(id), utf8("{}"))).resolves.toMatchObject({ ok: true });
    await expect(collect(client.streamFrames({}))).resolves.toHaveLength(1);
  });

  it("throws BrokerError (with status) when the broker rejects (e.g. 401 wrong identity)", async () => {
    broker.requireAuth(id.authToken); // only `id`'s bearer is accepted
    const strangerId = await deriveIdentity(new Uint8Array(32).fill(9));
    const stranger = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", strangerId),
      fetchFn: broker.fetch,
    });
    const err = await stranger.postFrame(header(strangerId), utf8("{}")).catch((e) => e);
    expect(BrokerError.is(err)).toBe(true);
    expect((err as BrokerError).status).toBe(401);
  });

  it("passes startIndex through (negative = recent window)", async () => {
    for (const n of [1, 2, 3]) {
      await client.postFrame(header(id, { msgId: `a${n}` }), utf8(JSON.stringify({ n })));
    }
    const frames = await collect(client.streamFrames({ startIndex: -2 }));
    const ns = await Promise.all(
      frames.map(async (f) => JSON.parse(td.decode(await client.openFrame(f))).n),
    );
    expect(ns).toEqual([2, 3]);
  });

  it("postMessage/openMessage round-trips a large message via chunks", async () => {
    const big = utf8("x".repeat(5000));
    await client.postMessage(
      header(id, { recordKind: "user", dir: "in", sessionId: "s", msgId: "big" }),
      big,
      2000,
    );
    const frames = await collect(client.streamFrames({ session: "s" }));
    expect(frames).toHaveLength(3); // ceil(5000 / 2000)
    expect(await client.openMessage(frames)).toEqual(big);
  });

  it("openMessage rejects chunks Frankensteined from two different messages (same parts count)", async () => {
    await client.postMessage(
      header(id, { recordKind: "user", dir: "in", sessionId: "x", msgId: "A" }),
      utf8("aaaa"),
      2,
    );
    await client.postMessage(
      header(id, { recordKind: "user", dir: "in", sessionId: "x", msgId: "B" }),
      utf8("bbbb"),
      2,
    );
    const all = await collect(client.streamFrames({ session: "x" }));
    const a0 = all.find((f) => f.msgId === "A" && f.part === 0);
    const b1 = all.find((f) => f.msgId === "B" && f.part === 1);
    if (a0 === undefined || b1 === undefined) throw new Error("missing chunks");
    await expect(client.openMessage([a0, b1])).rejects.toThrow(/same message/);
  });
});
