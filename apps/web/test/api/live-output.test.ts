import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  decodeFrame,
  encodeFrame,
  formatPass,
  type Identity,
  utf8,
  type WireFrame,
} from "@remote-claw/clawsec";
import {
  BrokerClient,
  LIVE_OUTPUT_KIND,
  type LiveOutput,
  liveOutputId,
  securityProvider,
} from "@remote-claw/cli/broker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "../../app/api/live-output/route";
import { POST } from "../../app/api/relay/route";
import { GET as stream } from "../../app/api/stream/route";
import { Viewer } from "../../app/lib/viewer";
import { PublishCollisionError } from "../../lib/broker/backend";
import { brokerCache } from "../../lib/broker/broker-cache";
import { LocalBackend } from "../../lib/broker/local";
import { dbFileName, FileDbLocator, SqliteMultiBackend } from "../../lib/broker/sqlite-multi";
import { channelToken } from "../../lib/channel";
import { announceFrame, bearer, header, uniqueIdentity } from "../helpers";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  brokerCache().delete("sqlite");
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rc-live-output-"));
  roots.push(dir);
  const backend = new SqliteMultiBackend(new FileDbLocator(dir));
  brokerCache().set("sqlite", backend);
  const identity = await uniqueIdentity();
  const token = channelToken(identity.identityId, "sess-1");
  const value: LiveOutput = {
    v: 1,
    startedAt: 1,
    incarnation: "launch-a",
    revision: 1,
    sentAt: Date.now(),
    item: {
      finalMsgId: `native-text-${"a".repeat(64)}`,
      text: "private live text",
      truncated: false,
    },
  };
  const seal = async (body = value, extra = {}) =>
    encodeFrame(
      await securityProvider("sealed", identity).sealFrame(
        "session",
        header(identity, { recordKind: LIVE_OUTPUT_KIND, msgId: liveOutputId(body), ...extra }),
        utf8(JSON.stringify(body)),
      ),
    );
  const request = (method: string, frame?: unknown, id: Identity = identity, session = "sess-1") =>
    new Request(`https://broker/api/live-output?backend=sqlite&session=${session}`, {
      method,
      headers: { authorization: bearer(id.authToken) },
      ...(frame === undefined ? {} : { body: JSON.stringify(frame) }),
    });
  const establish = async () =>
    backend.publish(token, await announceFrame(identity, {}, { recordKind: "assistant", seq: 0 }));
  return { dir, backend, identity, token, value, seal, request, establish };
}

describe("replaceable encrypted live output", () => {
  it("never provisions absent channels and keeps many updates out of durable cursors/history", async () => {
    const f = await fixture();
    expect(await (await GET(f.request("GET"))).json()).toEqual({ frame: null });
    expect(await (await PUT(f.request("PUT", await f.seal()))).json()).toEqual({ stored: false });
    expect(await new FileDbLocator(f.dir).exists(f.token)).toBe(false);
    await f.establish();
    for (let revision = 1; revision <= 30; revision++)
      await f.backend.putLiveOutput(f.token, await f.seal({ ...f.value, revision }));
    expect(await f.backend.frameCount(f.token)).toBe(1);
    expect(await f.backend.maxSeq(f.token)).toBe(0);
    const db = createClient({ url: `file:${join(f.dir, dbFileName(f.token))}` });
    expect((await db.execute("SELECT COUNT(*) AS n FROM live_output")).rows[0]?.n).toBe(1);
    const stored = (await db.execute("SELECT frame FROM live_output")).rows[0]?.frame;
    expect(String(stored)).not.toContain("private live text");
    db.close();
  });
  it("serializes two clients, preserves clear/expiry watermarks and rejects changed retry bytes", async () => {
    const f = await fixture();
    await f.establish();
    const peer = new SqliteMultiBackend(new FileDbLocator(f.dir));
    const newer = await f.seal({ ...f.value, revision: 5 });
    const old = await f.seal({ ...f.value, revision: 4 });
    await Promise.all([f.backend.putLiveOutput(f.token, newer), peer.putLiveOutput(f.token, old)]);
    expect(await peer.getLiveOutput(f.token)).toEqual(newer);
    await expect(peer.putLiveOutput(f.token, { ...newer, ct: "changed" })).rejects.toBeInstanceOf(
      PublishCollisionError,
    );
    const clear = await f.seal({ ...f.value, revision: 6, item: null });
    await peer.putLiveOutput(f.token, clear);
    await f.backend.putLiveOutput(f.token, newer);
    expect(await f.backend.getLiveOutput(f.token)).toEqual(clear);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    expect(await peer.getLiveOutput(f.token)).toBeNull();
    await f.backend.putLiveOutput(f.token, clear); // exact retry must not renew expiry
    await f.backend.putLiveOutput(f.token, newer);
    expect(await f.backend.getLiveOutput(f.token)).toBeNull();
    await expect(peer.putLiveOutput(f.token, { ...clear, ct: "changed" })).rejects.toBeInstanceOf(
      PublishCollisionError,
    );
  });
  it("isolates generations and closed channels without deleting transcript frames", async () => {
    const f = await fixture();
    await f.establish();
    const newer = await f.seal({ ...f.value, startedAt: 2, revision: 0 });
    await f.backend.putLiveOutput(f.token, newer);
    await f.backend.putLiveOutput(f.token, await f.seal({ ...f.value, revision: 100 }));
    expect(await f.backend.getLiveOutput(f.token)).toEqual(newer);
    await f.backend.publish(f.token, { __close: true });
    expect(await f.backend.getLiveOutput(f.token)).toBeNull();
    expect(await f.backend.putLiveOutput(f.token, newer)).toBe(false);
    await f.establish();
    expect(await f.backend.getLiveOutput(f.token)).toBeNull();
  });
  it("recreates disposable preview schema but never heals missing canonical continuity", async () => {
    const f = await fixture();
    await f.establish();
    await f.backend.putLiveOutput(f.token, await f.seal());
    const db = createClient({ url: `file:${join(f.dir, dbFileName(f.token))}` });
    await db.execute("DROP TABLE live_output");
    const fresh = new SqliteMultiBackend(new FileDbLocator(f.dir));
    expect(await fresh.getLiveOutput(f.token)).toBeNull();
    expect(await fresh.frameCount(f.token)).toBe(1);
    await db.execute("DELETE FROM channel");
    await expect(fresh.getLiveOutput(f.token)).rejects.toThrow("channel");
    await expect(fresh.putLiveOutput(f.token, await f.seal())).rejects.toThrow("channel");
    expect((await db.execute("SELECT COUNT(*) AS n FROM channel")).rows[0]?.n).toBe(0);
    expect((await db.execute("SELECT COUNT(*) AS n FROM frames")).rows[0]?.n).toBe(1);
    db.close();
  });

  it("enforces identity/session/header/body boundaries and never routes a preview into frames", async () => {
    const f = await fixture();
    await f.establish();
    const frame = await f.seal();
    expect((await PUT(f.request("PUT", frame, await uniqueIdentity()))).status).toBe(403);
    expect((await PUT(f.request("PUT", frame, f.identity, "other"))).status).toBe(400);
    for (const patch of [
      { seq: 0 },
      { dir: "in" },
      { parts: 2 },
      { client_msg_id: "x" },
      { msg_id: "preview.v1.01.a.1" },
    ])
      expect((await PUT(f.request("PUT", { ...frame, ...patch }))).status).toBe(400);
    expect((await PUT(f.request("PUT", { ...frame, ct: "x".repeat(33_000) }))).status).toBe(413);
    expect((await GET(new Request("https://broker/api/live-output?session=s"))).status).toBe(401);
    const result = await PUT(f.request("PUT", frame));
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(await result.json()).toEqual({ stored: true });
    expect(
      (
        await POST(
          new Request("https://broker/api/relay?backend=sqlite&session=sess-1", {
            method: "POST",
            headers: { authorization: bearer(f.identity.authToken) },
            body: JSON.stringify(frame),
          }),
        )
      ).status,
    ).toBe(400);
    brokerCache().set("sqlite", new LocalBackend());
    expect((await GET(f.request("GET"))).status).toBe(501);
  });

  it("serves two viewers and reload through authenticated generation/replay/finality state", async () => {
    const f = await fixture();
    await f.establish();
    let override: WireFrame | null | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/live-output")
        return override === undefined ? GET(req) : Response.json({ frame: override });
      if (url.pathname === "/api/stream") return stream(req);
      return POST(req);
    };
    const client = new BrokerClient({
      baseUrl: "https://broker",
      backend: "sqlite",
      provider: securityProvider("sealed", f.identity),
      fetchFn: fetcher,
    });
    await client.postFrame(
      header(f.identity, { recordKind: "session_announce" }),
      utf8(
        JSON.stringify({
          session_id: "sess-1",
          title: "Preview",
          sent_at: Date.now(),
          incarnation: "launch-a",
          incarnation_started_at: 1,
          announce_seq: 0,
          harness: { agent: "codex", mode: "app-server" },
          capabilities: { liveAssistant: true },
        }),
      ),
    );
    const pass = await formatPass(f.identity);
    const signal = new AbortController().signal;
    const viewer = async () => {
      const v = await Viewer.fromPass(pass, "https://broker", fetcher, "sqlite");
      for await (const _announce of v.announces(signal)) break;
      return v;
    };
    const first = await viewer();
    const second = await viewer();
    await f.backend.putLiveOutput(f.token, await f.seal());
    expect((await first.readLiveOutput("sess-1", signal))?.item?.text).toBe("private live text");
    expect(await second.readLiveOutput("sess-1", signal)).toEqual(f.value);
    expect(await (await viewer()).readLiveOutput("sess-1", signal)).toEqual(f.value);
    if (!f.value.item) throw new Error("missing item");
    override = await f.seal({ ...f.value, revision: 0, item: { ...f.value.item, text: "old" } });
    expect(await first.readLiveOutput("sess-1", signal)).toEqual(f.value);
    override = await f.seal({ ...f.value, revision: 2, item: null });
    expect((await first.readLiveOutput("sess-1", signal))?.item).toBeNull();
    override = await f.seal();
    expect((await first.readLiveOutput("sess-1", signal))?.item).toBeNull();
    override = await f.seal({ ...f.value, incarnation: "wrong", revision: 3 });
    expect(await first.readLiveOutput("sess-1", signal)).toBeNull();
    override = {
      ...(await f.seal()),
      ct: encodeFrame({ ...decodeFrame(await f.seal()), ct: new Uint8Array(20) }).ct,
    };
    expect(await first.readLiveOutput("sess-1", signal)).toBeNull();
    // An authenticated terminal wins even if a previously valid snapshot remains cached.
    override = await f.seal();
    await client.postFrame(
      header(f.identity, { recordKind: "session_terminal", msgId: "terminal-sess-1" }),
      utf8('{"v":1}'),
    );
    const ended = new AbortController();
    for await (const _observation of first.announces(ended.signal, undefined, () =>
      ended.abort(),
    )) {
      // A duplicate announcement may precede the absorbing terminal callback.
    }
    expect(await first.readLiveOutput("sess-1", signal)).toBeNull();
  });
});
