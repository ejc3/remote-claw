import {
  AeadError,
  deriveIdentity,
  type Frame,
  type FrameHeader,
  type Identity,
  toHex,
  utf8,
} from "@remote-claw/clawsec";
import { beforeEach, describe, expect, it } from "vitest";
import { securityProvider } from "../security/provider.js";
import {
  BROKER_CURSOR_TIMEOUT_MS,
  BROKER_STREAM_CONNECT_TIMEOUT_MS,
  BrokerClient,
  BrokerError,
  BrokerPermanentStorageLossError,
  type BrokerTimeoutError,
} from "./client.js";
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

/** Consume an expected buffered prefix, then break so AsyncGenerator.return() cancels MockBroker's
 * still-live `: open` stream exactly like a real client disconnect. */
async function take<T>(gen: AsyncGenerator<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
    if (out.length === count) return out;
  }
  throw new Error(`broker stream ended before ${count} frame(s)`);
}

async function takeUntil<T>(
  gen: AsyncGenerator<T>,
  predicate: (value: T) => boolean,
): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
    if (predicate(x)) return out;
  }
  throw new Error("broker stream ended before the expected frame");
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

  it("keeps cursor recovery outside the 60s server wall without lengthening stream establishment", () => {
    expect(BROKER_CURSOR_TIMEOUT_MS).toBe(70_000);
    expect(BROKER_STREAM_CONNECT_TIMEOUT_MS).toBe(20_000);
  });

  it("round-trips a sealed announce on the BUS: post → stream → open", async () => {
    const sent = { session_id: "sess-1", title: "laptop", sent_at: 1 };
    const res = await client.postFrame(header(id), utf8(JSON.stringify(sent)));
    expect(res).toMatchObject({ ok: true, channel: "bus" });
    expect(broker.posts[0]?.channel).toBe("bus"); // session_announce routed to the bus, no ?session
    expect(broker.posts[0]?.session).toBeNull();

    const [frame] = await take(client.streamFrames({}), 1);
    expect(frame).toBeDefined();
    if (frame === undefined) throw new Error("no frame");
    expect(JSON.parse(td.decode(await client.openFrame(frame)))).toMatchObject({ title: "laptop" });
  });

  it("maps only the exact content-free channel-loss disposition to the permanent-loss type", async () => {
    const lost = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: (() =>
        Promise.resolve(
          Response.json(
            {
              ok: false,
              code: "channel_storage_lost",
              // Even a compromised/misconfigured route cannot smuggle provider coordinates through
              // the typed error: its message is constructed locally from the stable disposition.
              error: "provider namespace secret-name was deleted",
            },
            { status: 410 },
          ),
        )) as typeof fetch,
    });

    const failure = await lost.postFrame(header(id), utf8("{}")).catch((error) => error);
    expect(failure).toBeInstanceOf(BrokerPermanentStorageLossError);
    expect((failure as Error).message).toBe("broker 410: permanent channel storage loss");
    expect((failure as Error).message).not.toContain("secret-name");

    const canary = "broker-error-credential-canary";
    const ordinaryGone = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: (() =>
        Promise.resolve(Response.json({ error: canary }, { status: 410 }))) as typeof fetch,
    });
    const ordinary = await ordinaryGone.postFrame(header(id), utf8("{}")).catch((error) => error);
    expect(ordinary).toBeInstanceOf(BrokerError);
    expect(ordinary).not.toBeInstanceOf(BrokerPermanentStorageLossError);
    expect((ordinary as BrokerError).status).toBe(410);
    expect((ordinary as Error).message).toBe("broker 410: request rejected");
    expect(String(ordinary)).not.toContain(canary);
  });

  it("routes session_terminal on K_meta to the BUS and absorbs retry/live reordering", async () => {
    const sid = "sess-terminal";
    const terminalHeader = header(id, {
      sessionId: sid,
      recordKind: "session_terminal",
      msgId: `terminal-${sid}`,
    });
    const first = await client.postFrame(terminalHeader, utf8('{"v":1}'));
    const retry = await client.postFrame(terminalHeader, utf8('{"v":1}')); // fresh AEAD, same op
    const late = await client.postFrame(
      header(id, { sessionId: sid, recordKind: "session_announce", msgId: "ann-too-late" }),
      utf8("{}"),
    );

    expect([first.created, retry.created, late.created]).toEqual([true, false, false]);
    expect(broker.posts).toHaveLength(3); // every attempt reached the broker
    expect(broker.posts.every((post) => post.channel === "bus" && post.session === null)).toBe(
      true,
    );
    const frames = await take(client.streamFrames({}), 1);
    expect(frames.map((frame) => frame.recordKind)).toEqual(["session_terminal"]);
    expect(td.decode(await client.openFrame(frames[0] as Frame))).toBe('{"v":1}');
  });

  it("threads an optional AbortSignal to the publish fetch", async () => {
    let resolveEntered!: (signal: AbortSignal) => void;
    const entered = new Promise<AbortSignal>((resolve) => {
      resolveEntered = resolve;
    });
    const abortingFetch: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        return Promise.reject(new Error("publish fetch received no signal"));
      }
      resolveEntered(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const abortable = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: abortingFetch,
    });
    const controller = new AbortController();

    const pending = abortable.postFrame(header(id), utf8("{}"), controller.signal);
    await expect(entered).resolves.toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("hard-times every cursor attempt even when fetch ignores abort, and observes late rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const cursor of ["seq", "frame-count"] as const) {
        let rejectLate: (reason: unknown) => void = () => {};
        let seenSignal: AbortSignal | undefined;
        const hostileFetch: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
          seenSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            rejectLate = reject;
          });
        }) as typeof fetch;
        const bounded = new BrokerClient({
          baseUrl: "http://broker.test",
          provider: securityProvider("sealed", id),
          fetchFn: hostileFetch,
          cursorTimeoutMs: 10,
        });

        const pending = cursor === "seq" ? bounded.seqCursor("s") : bounded.frameCountCursor("s");
        await expect(pending).rejects.toMatchObject({
          name: "BrokerTimeoutError",
          operation: expect.stringContaining(cursor === "seq" ? "seq" : "frame-count"),
        });
        expect(seenSignal?.aborted).toBe(true);

        // A non-cooperative fetch may reject after the wall. That settlement must remain observed.
        rejectLate(new Error(`late ${cursor} rejection`));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("hard-times initial stream headers when fetch never settles or honors AbortSignal", async () => {
    let streamSignal: AbortSignal | undefined;
    const hostileFetch: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      streamSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const bounded = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: hostileFetch,
      streamConnectTimeoutMs: 10,
    });

    await expect(collect(bounded.streamFrames({ session: "s" }))).rejects.toEqual(
      expect.objectContaining<Partial<BrokerTimeoutError>>({
        name: "BrokerTimeoutError",
        operation: "broker stream headers",
      }),
    );
    expect(streamSignal?.aborted).toBe(true);
  });

  it("rejects a bodyless successful stream instead of reporting a clean absent channel", async () => {
    const bodyless = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: (() =>
        Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        )) as typeof fetch,
    });

    await expect(collect(bodyless.streamFrames({ session: "s" }))).rejects.toMatchObject({
      name: "BrokerError",
      status: 502,
      message: expect.stringContaining("broker stream ended unexpectedly"),
    });
  });

  it("does not retain malformed broker frame data in its error", async () => {
    const canary = "credential-canary";
    const malformed = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: (() =>
        Promise.resolve(
          new Response(`: open\n\ndata: ${canary}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        )) as typeof fetch,
    });

    const failure = await collect(malformed.streamFrames({ session: "s" })).catch((error) => error);
    expect(failure).toMatchObject({
      name: "BrokerError",
      status: 502,
      message: "broker 502: invalid broker frame",
    });
    expect(String(failure)).not.toContain(canary);
  });

  it.each([
    "relay",
    "seq",
    "frame-count",
  ] as const)("does not retain invalid successful %s response data in its error", async (route) => {
    const canary = `successful-${route}-credential-canary`;
    const malformed = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: (() =>
        Promise.resolve(
          new Response(canary, { status: 200, headers: { "content-type": "application/json" } }),
        )) as typeof fetch,
    });

    const request =
      route === "relay"
        ? malformed.postFrame(header(id), utf8("{}"))
        : route === "seq"
          ? malformed.seqCursor("s")
          : malformed.frameCountCursor("s");
    const failure = await request.catch((error) => error);

    expect(failure).toMatchObject({
      name: "BrokerError",
      status: 502,
      message: "broker 502: invalid broker response",
    });
    expect(String(failure)).not.toContain(canary);
  });

  it.each([
    ["seq", { maxSeq: "0", durable: true }],
    ["frame-count", { frameCount: -1, durable: true }],
  ] as const)("fails closed on an invalid successful %s cursor shape", async (route, body) => {
    const malformed = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: (() => Promise.resolve(Response.json(body))) as typeof fetch,
    });

    const request = route === "seq" ? malformed.seqCursor("s") : malformed.frameCountCursor("s");
    await expect(request).rejects.toMatchObject({
      name: "BrokerError",
      status: 502,
      message: "broker 502: invalid broker response",
    });
  });

  it("returns cleanly only for MockBroker's explicit absent-channel response", async () => {
    await expect(collect(client.streamFrames({ session: "missing" }))).resolves.toEqual([]);
  });

  it("round-trips a content frame on the SESSION channel and tags ?session", async () => {
    const h = header(id, { recordKind: "assistant", seq: 0, sessionId: "sX" });
    await client.postFrame(h, utf8("hello from claude"));
    expect(broker.posts[0]?.channel).toBe("session");
    expect(broker.posts[0]?.session).toBe("sX");

    const [frame] = await take(client.streamFrames({ session: "sX" }), 1);
    if (frame === undefined) throw new Error("no frame");
    expect(td.decode(await client.openFrame(frame))).toBe("hello from claude");
  });

  it("rejects record_kind relabeling and same-plane session relabeling via derived AEAD/AAD", async () => {
    const postAndRead = async (h: FrameHeader, text: string): Promise<Frame> => {
      await client.postFrame(h, utf8(text));
      const frames = await takeUntil(
        client.streamFrames({ session: h.sessionId }),
        (frame) => frame.msgId === h.msgId,
      );
      const frame = frames.find((f) => f.msgId === h.msgId);
      if (frame === undefined) throw new Error(`missing frame ${h.msgId}`);
      return frame;
    };

    const control = await postAndRead(
      header(id, { recordKind: "interrupt", dir: "in", seq: null, msgId: "ctl-meta" }),
      "{}",
    );
    await expect(client.openFrame({ ...control, recordKind: "accepted" })).rejects.toBeInstanceOf(
      AeadError,
    );

    const content = await postAndRead(
      header(id, { recordKind: "assistant", seq: 0, msgId: "content-meta" }),
      "content body",
    );
    await expect(client.openFrame({ ...content, recordKind: "accepted" })).rejects.toBeInstanceOf(
      AeadError,
    );

    const meta = await postAndRead(
      header(id, { recordKind: "accepted", seq: null, msgId: "meta-content" }),
      JSON.stringify({ ok: true }),
    );
    await expect(client.openFrame({ ...meta, recordKind: "assistant" })).rejects.toBeInstanceOf(
      AeadError,
    );

    const samePlane = await postAndRead(
      header(id, { recordKind: "assistant", sessionId: "session-a", seq: 1, msgId: "same-plane" }),
      "same plane",
    );
    await expect(client.openFrame({ ...samePlane, sessionId: "session-b" })).rejects.toBeInstanceOf(
      AeadError,
    );
  });

  it("sends Authorization: Bearer <hex(auth_token)> on every call", async () => {
    broker.requireAuth(id.authToken);
    await expect(client.postFrame(header(id), utf8("{}"))).resolves.toMatchObject({ ok: true });
    await expect(take(client.streamFrames({}), 1)).resolves.toHaveLength(1);
  });

  it("sends x-vercel-protection-bypass on every call when configured, and omits it otherwise", async () => {
    const capture = (sink: Array<Record<string, string>>): typeof fetch =>
      ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        sink.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return broker.fetch(input, init);
      }) as typeof fetch;

    const withSeen: Array<Record<string, string>> = [];
    const withBypass = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: capture(withSeen),
      protectionBypass: "byp-secret-123",
    });
    await withBypass.postFrame(header(id), utf8("{}")); // publish
    await take(withBypass.streamFrames({}), 1); // subscribe
    expect(withSeen.length).toBeGreaterThanOrEqual(2);
    for (const h of withSeen) expect(h["x-vercel-protection-bypass"]).toBe("byp-secret-123");

    const noSeen: Array<Record<string, string>> = [];
    const noBypass = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: capture(noSeen),
    });
    await noBypass.postFrame(header(id), utf8("{}"));
    expect(noSeen[0]?.["x-vercel-protection-bypass"]).toBeUndefined();
  });

  it("forbids redirects on every credential-bearing broker request", async () => {
    const seen: Array<{ pathname: string; redirect: RequestRedirect | undefined }> = [];
    const capture: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({
        pathname: new URL(typeof input === "string" ? input : input.toString()).pathname,
        redirect: init?.redirect,
      });
      return broker.fetch(input, init);
    }) as typeof fetch;
    const guarded = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: capture,
      protectionBypass: "never-follow-me",
    });

    await guarded.postFrame(header(id), utf8("{}"));
    await take(guarded.streamFrames({}), 1);
    await guarded.seqCursor("sess-1");
    await guarded.frameCountCursor("sess-1");

    expect(seen.map(({ pathname }) => pathname)).toEqual([
      "/api/relay",
      "/api/stream",
      "/api/seq",
      "/api/frame-count",
    ]);
    expect(seen.every(({ redirect }) => redirect === "error")).toBe(true);
  });

  it("maxSeq/frameCount round-trip numbers/null and send auth + backend headers", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const capture: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({
        url: typeof input === "string" ? input : input.toString(),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return broker.fetch(input, init);
    }) as typeof fetch;
    const sqliteClient = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: capture,
      backend: "sqlite",
    });

    expect(sqliteClient.durable).toBe(false); // no server capability has been read yet
    expect(await sqliteClient.maxSeq("missing")).toBeNull();
    expect(sqliteClient.durable).toBe(true);
    expect(await sqliteClient.frameCount("missing")).toBeNull();
    await sqliteClient.postFrame(
      header(id, { recordKind: "accepted", seq: null, sessionId: "empty", msgId: "empty-1" }),
      utf8("{}"),
    );
    expect(await sqliteClient.maxSeq("empty")).toBeNull();
    expect(await sqliteClient.frameCount("empty")).toBe(1);
    await sqliteClient.postFrame(
      header(id, { recordKind: "assistant", seq: 2, sessionId: "seq-session", msgId: "seq-2" }),
      utf8("two"),
    );
    await sqliteClient.postFrame(
      header(id, { recordKind: "assistant", seq: 7, sessionId: "seq-session", msgId: "seq-7" }),
      utf8("seven"),
    );
    expect(await sqliteClient.maxSeq("seq-session")).toBe(7);
    expect(await sqliteClient.frameCount("seq-session")).toBe(2);

    const seqCalls = seen.filter((call) => new URL(call.url).pathname === "/api/seq");
    expect(seqCalls).toHaveLength(3);
    for (const call of seqCalls) {
      expect(call.headers.authorization).toBe(`Bearer ${toHex(id.authToken)}`);
      expect(call.headers["x-broker-backend"]).toBe("sqlite");
    }
    const countCalls = seen.filter((call) => new URL(call.url).pathname === "/api/frame-count");
    expect(countCalls).toHaveLength(3);
    for (const call of countCalls) {
      expect(call.headers.authorization).toBe(`Bearer ${toHex(id.authToken)}`);
      expect(call.headers["x-broker-backend"]).toBe("sqlite");
    }
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

  it("discovers durable=true from the server, including a durable default with no backend header", async () => {
    const mk = (backend?: string): BrokerClient =>
      new BrokerClient({
        baseUrl: "http://broker.test",
        provider: securityProvider("sealed", id),
        fetchFn: broker.fetch,
        ...(backend !== undefined ? { backend } : {}),
      });
    expect(mk("sqlite").durable).toBe(false); // the local flag alone is not trusted

    const defaultClient = mk(undefined);
    broker.durable = true;
    const cursor = await defaultClient.seqCursor("default-sqlite-session");
    expect(cursor).toEqual({ maxSeq: null, durable: true });
    expect(defaultClient.durable).toBe(true);

    broker.durable = false;
    const vercelClient = mk("vercel");
    expect(await vercelClient.seqCursor("default-vercel-session")).toEqual({
      maxSeq: null,
      durable: false,
    });
    expect(vercelClient.durable).toBe(false);
  });

  it("passes startIndex through (negative = recent window)", async () => {
    for (const n of [1, 2, 3]) {
      await client.postFrame(header(id, { msgId: `a${n}` }), utf8(JSON.stringify({ n })));
    }
    const frames = await take(client.streamFrames({ startIndex: -2 }), 2);
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
    const frames = await take(client.streamFrames({ session: "s" }), 3);
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
    const all = await take(client.streamFrames({ session: "x" }), 4);
    const a0 = all.find((f) => f.msgId === "A" && f.part === 0);
    const b1 = all.find((f) => f.msgId === "B" && f.part === 1);
    if (a0 === undefined || b1 === undefined) throw new Error("missing chunks");
    await expect(client.openMessage([a0, b1])).rejects.toThrow(/same message/);
  });
});
