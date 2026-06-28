import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFrame, deriveSessionKey, open, utf8, type WireFrame } from "@remote-claw/clawsec";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { GET as frameCountRoute } from "../app/api/frame-count/route";
import { MAX_RELAY_CIPHERTEXT_BYTES, POST as relay } from "../app/api/relay/route";
import { GET as seqRoute } from "../app/api/seq/route";
import { GET as stream } from "../app/api/stream/route";
import { announceFrame, bearer, header, readSseData, uniqueIdentity, wireFrame } from "./helpers";

afterAll(async () => {
  await teardownWorkflowTests();
});

const BASE = "http://localhost";
const td = new TextDecoder();

function post(
  frame: WireFrame,
  auth: string,
  session?: string,
  backend?: string,
): Promise<Response> {
  const params = new URLSearchParams();
  if (session !== undefined) params.set("session", session);
  if (backend !== undefined) params.set("backend", backend);
  const qs = params.toString();
  return relay(
    new Request(`${BASE}/api/relay${qs ? `?${qs}` : ""}`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(frame),
    }),
  );
}

function sub(auth: string, query = ""): Promise<Response> {
  return stream(new Request(`${BASE}/api/stream${query}`, { headers: { authorization: auth } }));
}

function seqReq(auth: string | undefined, query = ""): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth !== undefined) headers.authorization = auth;
  return seqRoute(new Request(`${BASE}/api/seq${query}`, { headers }));
}

function frameCountReq(auth: string | undefined, query = ""): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth !== undefined) headers.authorization = auth;
  return frameCountRoute(new Request(`${BASE}/api/frame-count${query}`, { headers }));
}

type BrokerGlobals = typeof globalThis & {
  __rcBrokerCache?: Map<string, unknown>;
};

function clearSqliteBackend(): void {
  // Drop the cached sqlite backend so a fresh RC_SQLITE_DIR is picked up by the next getBackend().
  (globalThis as BrokerGlobals).__rcBrokerCache?.delete("sqlite");
}

describe("broker: GET /api/seq (durable maxSeq cursor, A2b/#36)", () => {
  it("returns {maxSeq: null} for a backend without a durable maxSeq", async () => {
    const id = await uniqueIdentity();
    const res = await seqReq(bearer(id.authToken), "?session=sess-seq");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxSeq: null, durable: false });
  });

  it("rejects an unauthenticated request", async () => {
    const res = await seqReq(undefined);
    expect(res.status).toBe(401);
  });

  it("returns the highest seq from the sqlite route backend", async () => {
    const prevDir = process.env.RC_SQLITE_DIR;
    const prevBackend = process.env.BROKER_BACKEND;
    const dir = await mkdtemp(join(tmpdir(), "rc-seq-route-"));
    clearSqliteBackend();
    process.env.RC_SQLITE_DIR = dir;
    process.env.BROKER_BACKEND = "sqlite";
    try {
      const id = await uniqueIdentity();
      const auth = bearer(id.authToken);
      const sid = "sess-sqlite-seq";
      const kSession = await deriveSessionKey(id.contentRoot, sid);

      for (const seq of [2, 7]) {
        const frame = await wireFrame(
          kSession,
          header(id, {
            sessionId: sid,
            recordKind: "assistant",
            seq,
            dir: "out",
            msgId: `seq-${seq}`,
          }),
          utf8(`message ${seq}`),
        );
        expect((await post(frame, auth, sid)).status).toBe(200);
      }

      const res = await seqReq(auth, `?session=${encodeURIComponent(sid)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ maxSeq: 7, durable: true });
    } finally {
      clearSqliteBackend();
      if (prevDir === undefined) delete process.env.RC_SQLITE_DIR;
      else process.env.RC_SQLITE_DIR = prevDir;
      if (prevBackend === undefined) delete process.env.BROKER_BACKEND;
      else process.env.BROKER_BACKEND = prevBackend;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("broker: GET /api/frame-count (durable stream cursor)", () => {
  it("returns {frameCount: null} for a backend without a durable frame count", async () => {
    const id = await uniqueIdentity();
    const res = await frameCountReq(bearer(id.authToken), "?session=sess-count");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ frameCount: null, durable: false });
  });

  it("rejects an unauthenticated request", async () => {
    const res = await frameCountReq(undefined);
    expect(res.status).toBe(401);
  });

  it("returns the stream length from the sqlite route backend", async () => {
    const prevDir = process.env.RC_SQLITE_DIR;
    const prevBackend = process.env.BROKER_BACKEND;
    const dir = await mkdtemp(join(tmpdir(), "rc-count-route-"));
    clearSqliteBackend();
    process.env.RC_SQLITE_DIR = dir;
    process.env.BROKER_BACKEND = "sqlite";
    try {
      const id = await uniqueIdentity();
      const auth = bearer(id.authToken);
      const sid = "sess-sqlite-count";
      const kSession = await deriveSessionKey(id.contentRoot, sid);

      for (const seq of [2, 7]) {
        const frame = await wireFrame(
          kSession,
          header(id, {
            sessionId: sid,
            recordKind: "assistant",
            seq,
            dir: "out",
            msgId: `count-${seq}`,
          }),
          utf8(`message ${seq}`),
        );
        expect((await post(frame, auth, sid)).status).toBe(200);
      }

      const res = await frameCountReq(auth, `?session=${encodeURIComponent(sid)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ frameCount: 2, durable: true });
    } finally {
      clearSqliteBackend();
      if (prevDir === undefined) delete process.env.RC_SQLITE_DIR;
      else process.env.RC_SQLITE_DIR = prevDir;
      if (prevBackend === undefined) delete process.env.BROKER_BACKEND;
      else process.env.BROKER_BACKEND = prevBackend;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("broker: bus + per-session relay (P3, real Workflow runtime)", () => {
  it("E2E: a sealed bus announce round-trips host → POST /api/relay → bus → GET /api/stream → open", async () => {
    const id = await uniqueIdentity();
    const auth = bearer(id.authToken);
    const frame = await announceFrame(id, {
      session_id: "sess-1",
      title: "my laptop",
      sent_at: 123,
    });

    const pub = await post(frame, auth);
    expect(pub.status).toBe(200);
    expect(await pub.json()).toMatchObject({ ok: true, channel: "bus" });

    const res = await sub(auth, "?startIndex=0");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const [received] = (await readSseData(res, 1)) as [WireFrame];
    // The broker forwarded ciphertext verbatim; only the holder of K_meta can read it.
    const plaintext = await open(id.kMeta, decodeFrame(received));
    expect(JSON.parse(td.decode(plaintext))).toMatchObject({ title: "my laptop" });
  });

  it("E2E: a per-session content frame rides the session channel, not the bus", async () => {
    const id = await uniqueIdentity();
    const auth = bearer(id.authToken);
    const sid = "sess-A";
    const kSession = await deriveSessionKey(id.contentRoot, sid);
    const frame = await wireFrame(
      kSession,
      header(id, { sessionId: sid, recordKind: "assistant", seq: 0, dir: "out" }),
      utf8("hello from claude"),
    );

    const pub = await post(frame, auth, sid);
    expect(await pub.json()).toMatchObject({ ok: true, channel: "session" });

    // Readable on the session stream...
    const onSession = await readSseData(await sub(auth, `?session=${sid}&startIndex=0`), 1);
    expect(td.decode(await open(kSession, decodeFrame(onSession[0] as WireFrame)))).toBe(
      "hello from claude",
    );

    // ...but the identity BUS never saw it (no bus run exists -> 200 empty event-stream).
    const onBus = await readSseData(await sub(auth, "?startIndex=0"), 1);
    expect(onBus).toEqual([]);
  });

  it("multiple announces accumulate on one bus run in order; the recent window surfaces the freshest", async () => {
    const id = await uniqueIdentity();
    const auth = bearer(id.authToken);
    for (const n of [1, 2, 3]) {
      const f = await announceFrame(id, { session_id: `s${n}`, n, sent_at: n }, { msgId: `a${n}` });
      expect((await post(f, auth)).status).toBe(200);
    }
    const ns = async (res: Response, max: number): Promise<number[]> => {
      const frames = (await readSseData(res, max)) as WireFrame[];
      const bodies = await Promise.all(
        frames.map(async (w) => JSON.parse(td.decode(await open(id.kMeta, decodeFrame(w))))),
      );
      return bodies.map((b) => b.n as number);
    };
    // startIndex=0 deterministically replays the full buffer in publish order.
    expect(await ns(await sub(auth, "?startIndex=0"), 3)).toEqual([1, 2, 3]);
    // The recent window (negative startIndex) surfaces the freshest announce. Its EXACT last-N
    // semantics are real-Vercel-verified (spike §14A); the in-process harness only guarantees the
    // window is an in-order suffix that includes the latest, which is all the cold-start UX needs.
    const recent = await ns(await sub(auth, "?startIndex=-2"), 3);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.at(-1)).toBe(3);
    expect(recent).toEqual([1, 2, 3].slice(3 - recent.length)); // an in-order suffix of [1,2,3]
  });

  it("rejects an absent/malformed bearer with 401 (anti-scanning gate)", async () => {
    const id = await uniqueIdentity();
    const frame = await announceFrame(id, { session_id: "s", sent_at: 1 });
    // no Authorization
    const noAuth = await relay(
      new Request(`${BASE}/api/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(frame),
      }),
    );
    expect(noAuth.status).toBe(401);
    // not valid hex
    expect((await post(frame, "Bearer zzzz")).status).toBe(401);
    // valid hex but wrong length (16 bytes, not 32)
    expect((await post(frame, bearer(new Uint8Array(16)))).status).toBe(401);
    // GET stream is gated identically
    expect((await sub("")).status).toBe(401);
  });

  it("rejects a frame whose identity_id is not the bearer's (403) and malformed JSON (400)", async () => {
    const mine = await uniqueIdentity();
    const theirs = await uniqueIdentity();
    // A frame sealed/labelled for `theirs`, posted with `mine`'s bearer.
    const foreign = await announceFrame(theirs, { session_id: "s", sent_at: 1 });
    expect((await post(foreign, bearer(mine.authToken))).status).toBe(403);

    // Not a frame at all.
    const bad = await relay(
      new Request(`${BASE}/api/relay`, {
        method: "POST",
        headers: { authorization: bearer(mine.authToken), "content-type": "application/json" },
        body: JSON.stringify({ not: "a frame" }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("rejects ciphertext at the broker size cap while accepting a normal frame", async () => {
    const id = await uniqueIdentity();
    const auth = bearer(id.authToken);
    const normal = await announceFrame(id, { session_id: "s", sent_at: 1 });
    const oversized: WireFrame = {
      ...normal,
      ct: Buffer.alloc(MAX_RELAY_CIPHERTEXT_BYTES).toString("base64url"),
    };

    const tooLarge = await post(oversized, auth);
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).error).toMatch(/ciphertext exceeds/);

    const ok = await post(normal, auth);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, channel: "bus" });
  });

  it("rejects a non-integer startIndex with 400", async () => {
    const id = await uniqueIdentity();
    expect((await sub(bearer(id.authToken), "?startIndex=abc")).status).toBe(400);
  });

  it("rejects a non-announce frame on the bus channel (§6A: bus carries only session_announce)", async () => {
    const id = await uniqueIdentity();
    const auth = bearer(id.authToken);
    // A content frame with no ?session targets the bus — that must be refused (event-cap protection).
    const content = await wireFrame(
      id.kMeta,
      header(id, { recordKind: "assistant", seq: 0 }),
      utf8("should not ride the bus"),
    );
    const res = await post(content, auth);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only session_announce/);
  });

  it("rejects a frame whose session_id disagrees with ?session (no cross-session smuggling)", async () => {
    const id = await uniqueIdentity();
    const auth = bearer(id.authToken);
    const kA = await deriveSessionKey(id.contentRoot, "A");
    // A frame sealed + labelled for session A, attempted onto session B's channel.
    const frame = await wireFrame(
      kA,
      header(id, { sessionId: "A", recordKind: "assistant", seq: 0 }),
      utf8("for A only"),
    );
    const res = await post(frame, auth, "B");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match \?session/);
    // Positive control: the same frame on its own channel is accepted.
    expect((await post(frame, auth, "A")).status).toBe(200);
  });

  it("isolates channels: A's content stays on A, B's on B, and neither leaks onto a (non-empty) bus", async () => {
    const id = await uniqueIdentity();
    const auth = bearer(id.authToken);
    const kA = await deriveSessionKey(id.contentRoot, "A");
    const kB = await deriveSessionKey(id.contentRoot, "B");
    // Make the bus NON-empty first (an announce), so "no content on the bus" is a real isolation
    // assertion, not just "the bus run never started".
    await post(await announceFrame(id, { session_id: "A", sent_at: 1 }), auth);
    await post(
      await wireFrame(
        kA,
        header(id, { sessionId: "A", recordKind: "assistant", seq: 0 }),
        utf8("A-secret"),
      ),
      auth,
      "A",
    );
    await post(
      await wireFrame(
        kB,
        header(id, { sessionId: "B", recordKind: "assistant", seq: 0 }),
        utf8("B-secret"),
      ),
      auth,
      "B",
    );

    const [aFrame] = (await readSseData(await sub(auth, "?session=A&startIndex=0"), 1)) as [
      WireFrame,
    ];
    if (aFrame === undefined) throw new Error("A stream empty");
    expect(td.decode(await open(kA, decodeFrame(aFrame)))).toBe("A-secret");

    const [bFrame] = (await readSseData(await sub(auth, "?session=B&startIndex=0"), 1)) as [
      WireFrame,
    ];
    if (bFrame === undefined) throw new Error("B stream empty");
    expect(td.decode(await open(kB, decodeFrame(bFrame)))).toBe("B-secret");

    // The bus is non-empty but carries ONLY the announce — neither session's content leaked onto it.
    const busFrames = (await readSseData(await sub(auth, "?startIndex=0"), 2)) as WireFrame[];
    expect(busFrames).toHaveLength(1);
    expect(busFrames[0]?.record_kind).toBe("session_announce");
  });
});
