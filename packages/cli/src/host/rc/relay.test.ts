import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it } from "vitest";
import { type BrokerClient, BrokerError } from "../../broker/client.js";
import { extForMime, HostRcRelay, isLikelyBase64, safeAttachmentName } from "./relay.js";
import { Session } from "./session.js";

describe("safeAttachmentName", () => {
  it("strips path separators + odd chars and keeps a basename", () => {
    expect(safeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("a/b/IMG 1.png")).toBe("IMG_1.png");
    expect(safeAttachmentName("weird*name?.jpeg")).toBe("weird_name_.jpeg");
  });
  it("falls back for an empty/dotfile-only name", () => {
    expect(safeAttachmentName("")).toBe("attachment");
    expect(safeAttachmentName("...")).toBe("attachment");
    expect(safeAttachmentName("/")).toBe("attachment");
  });
});

describe("extForMime / isLikelyBase64", () => {
  it("maps known image mimes and rejects unknown", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/webp")).toBe("webp");
    expect(extForMime("application/pdf")).toBe("");
    expect(extForMime("")).toBe("");
  });
  it("accepts well-formed base64 and rejects malformed/empty", () => {
    expect(isLikelyBase64(Buffer.from("hello").toString("base64"))).toBe(true);
    expect(isLikelyBase64("")).toBe(false);
    expect(isLikelyBase64("!!!!")).toBe(false); // non-base64 chars
    expect(isLikelyBase64("Zm9v!")).toBe(false); // bad length + char
    expect(isLikelyBase64("abc")).toBe(false); // length not a multiple of 4
  });
});

// Adversarial-review fixes for the relay's two-pump seq discipline (the mid-stream-gap bug) and the
// sticky `needs` flag. We drive the REAL HostRcRelay.serve() loop with a controllable fake broker
// client so a publish can be made to FAIL (and BLOCK) deterministically — the failure path the real
// broker won't reproduce on demand.

const ID = new Uint8Array(16);
const enc = (s: string) => new TextEncoder().encode(s);

interface Posted {
  recordKind: string;
  seq: number | null;
  msgId: string;
  text: string;
}

/** A fake BrokerClient: records posts, can fail a post by seq or block+fail one by record_kind, and
 *  streams a queued set of inbound frames then parks until aborted (like a live SSE subscription). */
class FakeClient {
  posts: Posted[] = [];
  /** Content posts only (seq !== null) — the durable transcript the viewer's orderer consumes. */
  get content(): Posted[] {
    return this.posts.filter((p) => p.seq !== null);
  }
  announces: Array<Record<string, unknown>> = [];

  failSeq: number | null = null; // fail postMessage when header.seq === failSeq

  #inbound: Frame[] = [];
  #wake: (() => void) | null = null;

  queueInbound(f: Frame): void {
    this.#inbound.push(f);
  }

  /** Deliver an inbound frame to a LIVE stream (after streaming has started + parked). */
  pushInbound(f: Frame): void {
    this.#inbound.push(f);
    this.#wake?.();
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    const text = new TextDecoder().decode(body);
    if (this.failSeq !== null && header.seq === this.failSeq) {
      throw new BrokerError(500, "injected failure");
    }
    this.posts.push({ recordKind: header.recordKind, seq: header.seq, msgId: header.msgId, text });
    return [{ ok: true, channel: "session", runId: "r", created: false }];
  }

  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    const text = new TextDecoder().decode(body);
    if (header.recordKind === "session_announce") {
      try {
        this.announces.push(JSON.parse(text));
      } catch {
        /* ignore */
      }
    }
    this.posts.push({ recordKind: header.recordKind, seq: header.seq, msgId: header.msgId, text });
    return { ok: true, channel: "bus", runId: "r", created: false };
  }

  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    for (;;) {
      while (this.#inbound.length > 0) {
        const f = this.#inbound.shift();
        if (f !== undefined) yield f;
      }
      if (opts.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      this.#wake = null;
    }
  }

  openFrame(frame: Frame): Promise<Uint8Array> {
    return Promise.resolve(frame.ct); // inbound test frames stash plaintext in `ct`
  }
}

/** A `dir:"in"` client frame the relay's inbound pump will process (plaintext stashed in `ct`). */
function inFrame(recordKind: string, msgId: string, text: string, clientMsgId?: string): Frame {
  return {
    v: 1,
    identityId: ID,
    sessionId: "s",
    dir: "in",
    recordKind,
    seq: null,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...(clientMsgId !== undefined ? { clientMsgId } : {}),
    salt: new Uint8Array(32),
    nonce: new Uint8Array(12),
    ct: enc(text),
  } as Frame;
}

function relayOf(session: Session, client: FakeClient): HostRcRelay {
  return new HostRcRelay({
    client: client as unknown as BrokerClient,
    identityId: ID,
    sessionId: session.id,
    session,
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await tick();
  if (!pred()) throw new Error("timed out");
}
function assistant(text: string): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("HostRcRelay seq discipline (adversarial-review fixes)", () => {
  it("a failing content post HALTS the relay (serve rejects) with a gap-free durable prefix", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.failSeq = 1; // the SECOND content frame's post fails
    const relay = relayOf(session, client);
    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));

    // The coupled pumps tear down on the publish failure; serve() rejects.
    await expect(relay.serve(new AbortController().signal)).rejects.toThrow();

    // Only seq 0 was durably posted; seq 1 (failed) and seq 2 (never allocated — halted) are absent.
    // The channel is a clean prefix, NOT [0, 2] with a permanent hole at 1.
    expect(client.content.map((p) => p.seq)).toEqual([0]);
  });

  it("a fatal INBOUND publish failure tears the relay down (couples both pumps; no silent retry-limp)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.failSeq = 0; // the inbound `user` echo (the first content seq) fails → #fatal
    const relay = relayOf(session, client);
    client.queueInbound(inFrame("user", "c-1", "hello", "c-1"));

    // Pre-fix, #pumpInbound would swallow the failure and retry forever (a live session limping behind
    // a burned seq). Now it latches #fatal and serve() couples the pumps → the whole relay tears down.
    const outcome = await relay.serve(new AbortController().signal).then(
      () => "resolved",
      () => "rejected",
    );
    expect(outcome).toBe("rejected");
    // The failed echo never became a durable content frame (only the seq:null `accepted` was attempted).
    expect(client.content.map((p) => p.seq)).toEqual([]);
  });

  it("a worker control_cancel_request clears an open gate so `needs` doesn't stick (grounded fix)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    await relay.announce("box"); // begin announcing presence (initial needs=false)
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    // The outbound pump opens a can_use_tool gate → needs=true announced.
    session.pushUpstream({
      type: "control_request",
      request_id: "perm-x",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "echo" } },
    });
    await waitFor(() => client.announces.at(-1)?.needs === true);

    // The worker then CANCELS that gate (real RC `control_cancel_request`, captured via --rc-trace) →
    // the relay clears #openPerms and re-announces needs=false. (Same pump, so order is deterministic.)
    session.pushUpstream({ type: "control_cancel_request", request_id: "perm-x" });
    await waitFor(() => client.announces.at(-1)?.needs === false);
    ac.abort();
    await served;

    expect(client.announces.at(-1)?.needs).toBe(false); // the gate was cleared, not left pinned
    expect(client.announces.some((a) => a.needs === true)).toBe(true); // we saw the open→clear transition
  });

  it("the interrupt verb is a backstop that also clears an open gate", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    await relay.announce("box");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream({
      type: "control_request",
      request_id: "perm-y",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: {} },
    });
    await waitFor(() => client.announces.at(-1)?.needs === true); // gate open

    // A viewer ESC with NO subsequent worker cancel — the interrupt-verb backstop clears the gate.
    client.pushInbound(inFrame("interrupt", "int-1", JSON.stringify({})));
    await waitFor(() => client.announces.at(-1)?.needs === false);
    ac.abort();
    await served;

    expect(client.announces.at(-1)?.needs).toBe(false);
  });
});

describe("HostRcRelay attachments (#44)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("writes a viewer attachment to disk (sanitized name) and echoes a user frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    const bytes = Buffer.from("PNGDATA-καλημέρα-\x00\x01\x02");
    client.queueInbound(
      inFrame(
        "attachment",
        "att-1",
        JSON.stringify({
          name: "../IMG 1.png", // path traversal + space → must sanitize to IMG_1.png
          mime: "image/png",
          data: bytes.toString("base64"),
          caption: "look at this",
        }),
      ),
    );
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    // The bytes were written under a SANITIZED basename (traversal stripped) carrying a unique prefix +
    // the mime-derived extension, byte-for-byte. There is exactly one file.
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const written = files[0] as string;
    expect(written).toMatch(/^[a-z0-9]+-IMG_1\.png$/); // <unique>-IMG_1.png (mime image/png → .png)
    expect(readFileSync(join(dir, written)).equals(bytes)).toBe(true);
    // The transcript echo shows the attachment chip (the original display name) + the caption.
    const echo = client.content.find((p) => p.recordKind === "user");
    expect(echo?.text).toContain("📎 IMG_1.png");
    expect(echo?.text).toContain("look at this");
  });

  it("rewrites the on-disk extension to match the mime, not the original name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    const bytes = Buffer.from("JPEGDATA");
    // The viewer always re-encodes to JPEG, so a ".png" source name must land as ".jpg" on disk.
    client.queueInbound(
      inFrame(
        "attachment",
        "att-2",
        JSON.stringify({ name: "photo.png", mime: "image/jpeg", data: bytes.toString("base64") }),
      ),
    );
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    const written = readdirSync(dir)[0] as string;
    expect(written).toMatch(/^[a-z0-9]+-photo\.jpg$/); // extension follows the JPEG bytes
    const echo = client.content.find((p) => p.recordKind === "user");
    expect(echo?.text).toContain("📎 photo.png"); // …but the chip keeps the original display name
  });

  it("drops a malformed-base64 attachment: no file, no echo, no seq burned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    // A bad attachment, then a normal user frame: the user echo proves the relay kept running and that
    // the bad attachment neither wrote a file nor emitted a content frame (and burned no seq → seq 0).
    client.queueInbound(
      inFrame(
        "attachment",
        "bad-1",
        JSON.stringify({ name: "x.png", mime: "image/png", data: "!!!!" }),
      ),
    );
    client.queueInbound(inFrame("user", "u-1", "hi"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    expect(readdirSync(dir)).toHaveLength(0); // nothing written for the bad frame
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1); // only the real user frame echoed
    expect(users[0]?.seq).toBe(0); // the dropped attachment burned no seq
  });
});

// #36 — "deep-history worker backfill" GROUNDING.
//
// The v2-architecture §6 design had the WORKER re-emit prior turns as `historical:true` frames on RC
// (re)connect, gated by a completeness check. The real RC protocol (captured via --rc-trace) does NOT
// do this: `POST .../bridge` returns only a worker_jwt (no transcript); the SSE stream carries only NEW
// inputs; a `--resume`d worker is streamed NO prior history; `historical` appears in zero captures. So
// there is nothing to backfill FROM the worker, and nothing to gate on.
//
// Instead, the RELAY is the source of truth for its session's transcript: every content frame is
// appended to `#log`, and a mid-session (re)connecting viewer replays the COMPLETE history from that log
// via `catch_up` (§8) — no worker round-trip. These tests simulate that mid-session reconnect end to end
// against the real relay, which is what #36 actually needs to guarantee.
describe("HostRcRelay mid-session reconnect = complete history from the relay log (#36)", () => {
  it("a viewer that joins mid-session catch_up's the WHOLE prior transcript (no worker backfill)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    // Drive a few turns so the relay accumulates a transcript (seq 0,1,2) BEFORE any viewer is present.
    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));
    await waitFor(() => client.content.length >= 3);
    const original = client.content.map((p) => ({ seq: p.seq, msgId: p.msgId, text: p.text }));
    expect(original.map((p) => p.seq)).toEqual([0, 1, 2]);

    // A late viewer connects and asks for everything since the start (mid-session reconnect).
    client.pushInbound(inFrame("catch_up", "cu-1", JSON.stringify({ since: 0 })));
    await waitFor(() => client.content.length >= 6);
    ac.abort();
    await served;

    // The replay re-posted the ENTIRE prior transcript with identical seq+msg_id+text — the late viewer
    // reconstructs the full history from the relay log alone (the viewer's orderer dedups the re-posts).
    const replayed = client.content
      .slice(3, 6)
      .map((p) => ({ seq: p.seq, msgId: p.msgId, text: p.text }));
    expect(replayed).toEqual(original);
  });

  it("an incremental catch_up replays only frames at/after `since` (no gap, no over-send)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));
    await waitFor(() => client.content.length >= 3);

    // A viewer that already has seq 0 reconnects mid-session and only needs the tail (1,2).
    client.pushInbound(inFrame("catch_up", "cu-2", JSON.stringify({ since: 1 })));
    await waitFor(() => client.content.length >= 5);
    ac.abort();
    await served;

    expect(client.content.slice(3).map((p) => p.seq)).toEqual([1, 2]); // only the missing tail
  });
});

describe("HostRcRelay inbound framing (single-frame invariant)", () => {
  it("drops a multi-part inbound frame instead of acting on a truncated first part", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    // A `user` frame claiming parts=2 (openFrame would yield only part 0 — a truncated prompt). It must
    // be dropped, NOT injected. A normal single-frame prompt follows and must still be processed (the
    // relay kept running, and the dropped frame burned no seq).
    client.queueInbound({ ...inFrame("user", "mp-1", "hello"), parts: 2 } as Frame);
    client.queueInbound(inFrame("user", "u-1", "world"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1); // only the single-frame prompt echoed
    expect(users[0]?.text).toBe("world"); // the multi-part "hello" was dropped, not injected
    expect(users[0]?.seq).toBe(0); // the dropped frame burned no seq
  });
});
