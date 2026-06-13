import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type BrokerClient, BrokerError } from "../../broker/client.js";
import type { Tracer } from "../../trace.js";
import {
  extForMime,
  HostRcRelay,
  isLikelyBase64,
  MAX_ATTACHMENT_B64,
  safeAttachmentName,
} from "./relay.js";
import { Session } from "./session.js";

/** A capturing tracer that records `error` lines (and is its own `child`) — for asserting alerts. */
function spyTracer(): {
  tracer: Tracer;
  errors: Array<{ msg: string; fields: Record<string, unknown> | undefined }>;
} {
  const errors: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const noop = () => {};
  const t = {
    error: (msg: string, fields?: Record<string, unknown>) => errors.push({ msg, fields }),
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => t,
  } as unknown as Tracer;
  return { tracer: t, errors };
}

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

  /** Legacy synchronous client hint. The real relay no longer trusts this for safety; it waits for
   *  seqCursor().durable from the server. */
  durable = false;
  /** Server-reported effective durability returned by seqCursor()/frameCountCursor(). */
  reportedDurable = false;

  /** Mirrors BrokerClient.maxSeq — the durable log's highest seq when a durable host (re)starts a
   *  session. null ⇒ start fresh at 0; a number ⇒ resume at value+1 (#36). serve() reads it on durable
   *  starts only. `maxSeqFailures` simulates transient read failures before a later success. */
  maxSeqValue: number | null = null;
  maxSeqThrows = false;
  maxSeqFailures = 0;
  maxSeqCalls = 0;
  async seqCursor(_sessionId?: string): Promise<{ maxSeq: number | null; durable: boolean }> {
    this.maxSeqCalls++;
    if (this.maxSeqFailures > 0) {
      this.maxSeqFailures--;
      throw new BrokerError(500, "maxSeq failed");
    }
    if (this.maxSeqThrows) throw new BrokerError(500, "maxSeq failed");
    return { maxSeq: this.maxSeqValue, durable: this.reportedDurable };
  }
  async maxSeq(sessionId?: string): Promise<number | null> {
    return (await this.seqCursor(sessionId)).maxSeq;
  }

  frameCountCalls = 0;
  frameCountThrows = false;
  frameCountFailures = 0;
  async frameCountCursor(
    _sessionId?: string,
  ): Promise<{ frameCount: number | null; durable: boolean }> {
    this.frameCountCalls++;
    if (this.frameCountFailures > 0) {
      this.frameCountFailures--;
      throw new BrokerError(500, "frameCount failed");
    }
    if (this.frameCountThrows) throw new BrokerError(500, "frameCount failed");
    return { frameCount: this.#inbound.length, durable: this.reportedDurable };
  }
  async frameCount(sessionId?: string): Promise<number | null> {
    return (await this.frameCountCursor(sessionId)).frameCount;
  }

  failSeq: number | null = null; // fail postMessage when header.seq === failSeq
  failRecordKind: string | null = null; // fail postMessage when header.recordKind matches
  onAnnounce: (() => void) | null = null;

  #inbound: Frame[] = [];
  #wakes = new Set<() => void>();
  streamStarts: Array<number | undefined> = [];

  queueInbound(f: Frame): void {
    this.#inbound.push(f);
  }

  /** Deliver an inbound frame to a LIVE stream (after streaming has started + parked). */
  pushInbound(f: Frame): void {
    this.#inbound.push(f);
    for (const wake of this.#wakes) wake();
    this.#wakes.clear();
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    const text = new TextDecoder().decode(body);
    if (this.failSeq !== null && header.seq === this.failSeq) {
      throw new BrokerError(500, "injected failure");
    }
    if (this.failRecordKind !== null && header.recordKind === this.failRecordKind) {
      throw new BrokerError(500, `injected ${header.recordKind} failure`);
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
      this.onAnnounce?.();
    }
    this.posts.push({ recordKind: header.recordKind, seq: header.seq, msgId: header.msgId, text });
    return { ok: true, channel: "bus", runId: "r", created: false };
  }

  async *streamFrames(opts: { startIndex?: number; signal?: AbortSignal }): AsyncGenerator<Frame> {
    this.streamStarts.push(opts.startIndex);
    let cursor =
      opts.startIndex === undefined
        ? 0
        : Math.max(0, Math.min(opts.startIndex, this.#inbound.length));
    for (;;) {
      while (cursor < this.#inbound.length) {
        const f = this.#inbound[cursor++];
        if (f !== undefined) yield f;
      }
      if (opts.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.#wakes.delete(wake);
          opts.signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.#wakes.add(wake);
        opts.signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  /** msgIds whose openFrame should REJECT — simulates an AEAD/auth failure (forged/tampered frame). */
  failOpen = new Set<string>();
  /** Every msgId passed to openFrame, in order — lets a test prove which inbound frames the relay
   *  actually DECRYPTED (e.g. the durable path consumes a catch_up frame without ever opening it). */
  opened: string[] = [];

  openFrame(frame: Frame): Promise<Uint8Array> {
    this.opened.push(frame.msgId);
    if (this.failOpen.has(frame.msgId)) return Promise.reject(new Error("AEAD open failed"));
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

  it("emits an ERROR alert naming the burned seq when a content post fails terminally (#4)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.failSeq = 1; // the second content post fails terminally → seq 1 is burned
    const { tracer, errors } = spyTracer();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      tracer,
    });
    for (const a of ["a0", "a1"]) session.pushUpstream(assistant(a));
    await relay.serve(new AbortController().signal).catch(() => {});

    // The teardown is now also an actionable alert: an ERROR line that names the burned seq.
    const alert = errors.find((e) => e.msg.includes("seq burned"));
    expect(alert).toBeDefined();
    expect(alert?.fields?.seq).toBe(1);
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

  it("permission_resolved is unordered (seq=null), does not burn content seq, and replays on catch_up", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream({
      type: "control_request",
      request_id: "perm-v4",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "echo" } },
    });
    await waitFor(() => client.content.some((p) => p.recordKind === "permission_request"));

    client.pushInbound(
      inFrame(
        "permission",
        "perm-in-v4",
        JSON.stringify({ request_id: "perm-v4", behavior: "allow" }),
      ),
    );
    await waitFor(() => client.posts.some((p) => p.recordKind === "permission_resolved"));

    const resolved = client.posts.find((p) => p.recordKind === "permission_resolved");
    expect(resolved?.seq).toBeNull();
    expect(JSON.parse(resolved?.text ?? "{}")).toMatchObject({
      request_id: "perm-v4",
      behavior: "allow",
    });

    session.pushUpstream(assistant("after permission"));
    await waitFor(() => client.content.some((p) => p.recordKind === "assistant"));
    expect(client.content.map((p) => p.seq)).toEqual([0, 1]);

    client.pushInbound(inFrame("catch_up", "cu-perm-v4", JSON.stringify({ since: 1 })));
    await waitFor(
      () => client.posts.filter((p) => p.recordKind === "permission_resolved").length >= 2,
    );
    ac.abort();
    await served;

    const replayed = client.posts.filter((p) => p.recordKind === "permission_resolved").at(-1);
    expect(replayed?.seq).toBeNull();
    expect(replayed?.msgId).toBe(resolved?.msgId);
  });

  it("does not apply a permission grant when logging permission_resolved fails", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const pushControl = vi.spyOn(session, "pushControlResponse");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => "resolved",
      () => "rejected",
    );

    session.pushUpstream({
      type: "control_request",
      request_id: "perm-log-first",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "echo" } },
    });
    await waitFor(() => client.content.some((p) => p.recordKind === "permission_request"));

    client.failRecordKind = "permission_resolved";
    client.pushInbound(
      inFrame(
        "permission",
        "perm-log-first-in",
        JSON.stringify({ request_id: "perm-log-first", behavior: "allow" }),
      ),
    );

    await expect(served).resolves.toBe("rejected");
    expect(pushControl).not.toHaveBeenCalled();
    expect(client.posts.filter((p) => p.recordKind === "permission_resolved")).toHaveLength(0);
  });

  it("echoes an AskUserQuestion's questions back in the answer's updatedInput (the q.map fix, #42)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const pushControl = vi.spyOn(session, "pushControlResponse");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    // Worker raises an AskUserQuestion can_use_tool with its questions under `input` (real claude shape).
    const questions = [
      {
        question: "Which name?",
        header: "Name",
        multiSelect: false,
        options: [{ label: "Orion" }],
      },
    ];
    session.pushUpstream({
      type: "control_request",
      request_id: "askq-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_q1",
        input: { questions },
      },
    });
    await waitFor(() => client.content.some((p) => p.recordKind === "permission_request"));

    // The viewer answers with the chosen option (+ the request's tool_use_id) but NOT the questions.
    client.pushInbound(
      inFrame(
        "permission",
        "askq-1-in",
        JSON.stringify({
          request_id: "askq-1",
          behavior: "allow",
          tool_use_id: "toolu_q1",
          answers: { "Which name?": "Orion" },
        }),
      ),
    );
    await waitFor(() => pushControl.mock.calls.length === 1);
    ac.abort();
    await served;

    // The relay must reattach the ORIGINAL questions so claude's call({questions,answers}) doesn't q.map undefined.
    expect(pushControl).toHaveBeenCalledWith(
      "askq-1",
      "allow",
      expect.objectContaining({
        toolUseId: "toolu_q1",
        answers: { "Which name?": "Orion" },
        questions,
      }),
    );
  });
});

describe("HostRcRelay permission mode presence", () => {
  it("seeds the announced mode from session config", async () => {
    const session = new Session("s", "t", { permissionMode: "default" });
    const client = new FakeClient();
    const relay = relayOf(session, client);

    await relay.announce("box");

    expect(client.announces.at(-1)?.mode).toBe("default");
  });

  it("updates mode from a worker system init event and re-announces", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    await relay.announce("box");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream({ type: "system", subtype: "init", permissionMode: "plan" });
    await waitFor(() => client.announces.at(-1)?.mode === "plan");
    ac.abort();
    await served;

    expect(session.permissionMode).toBe("plan");
    expect(client.announces.at(-1)?.mode).toBe("plan");
  });

  it("updates mode from an inbound set_mode verb, forwards it, and re-announces", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const pushControl = vi.spyOn(session, "pushControlRequest");
    await relay.announce("box");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    client.pushInbound(
      inFrame("set_mode", "mode-1", JSON.stringify({ mode: "plan", expiry: Date.now() + 60_000 })),
    );
    await waitFor(() => client.announces.at(-1)?.mode === "plan");
    ac.abort();
    await served;

    expect(session.permissionMode).toBe("plan");
    expect(pushControl).toHaveBeenCalledWith("set_permission_mode", { mode: "plan" });
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
    const pushUser = vi.spyOn(session, "pushUserInput");
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
    // claude is handed the on-disk file via the native `@"<abs-path>"` reference (matches real
    // Anthropic's upload resolution — frame 224), not a "use the Read tool" instruction.
    const injected = (pushUser.mock.calls.at(-1)?.[0] as string | undefined) ?? "";
    expect(injected).toMatch(/^@"[^"]*-IMG_1\.png" look at this$/);
    expect(injected).toContain(`@"${join(dir, written)}"`);
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

// A2a — on a DURABLE-log backend (per-session SQLite) the broker keeps every frame, so a (re)connecting viewer's
// subscribe(startIndex:0) replays the whole transcript on its own. The host then must NOT also keep an
// in-memory `#log` or re-post it on `catch_up` (that would be pure waste — the frames are already in the
// durable log and already delivered by subscribe). "One log, mediated by the broker."
describe("HostRcRelay durable backend retires the host catch_up replay (A2a)", () => {
  it("DURABLE: catch_up is consumed but never opened or replayed", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true; // server-reported durable libSQL backend
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    // Drive a few turns: the content frames are POSTed live (into the durable log, in production).
    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));
    await waitFor(() => client.content.length >= 3);

    // Deliver a catch_up, then a real `user` prompt BEHIND it on the same inbound stream. The inbound
    // pump is FIFO, so the relay processing the user prompt PROVES it got past the catch_up (consumed,
    // not stuck) — without us needing to peek at any private state.
    client.pushInbound(inFrame("catch_up", "cu-d", JSON.stringify({ since: 0 })));
    client.pushInbound(inFrame("user", "u-1", "hi from viewer"));
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    // The user frame WAS opened (decrypted) — the pump reached past the catch_up …
    expect(client.opened).toContain("u-1");
    // … but the catch_up frame was NEVER opened: the durable short-circuit skips it (its `since` is
    // irrelevant — the durable log's own subscribe serves history). If that short-circuit regressed to
    // open+replay, "cu-d" would appear here. (Pins relay.ts catch_up handler.)
    expect(client.opened).not.toContain("cu-d");
    // … and nothing was re-posted: the only content frames are the 3 live ones + the echoed user prompt
    // (seq 3). No replay of seq 0–2 (contrast the non-durable test below, which re-posts them).
    expect(client.content.map((p) => p.seq)).toEqual([0, 1, 2, 3]);
  });

  it("NON-DURABLE (contrast): catch_up IS opened and replays the host #log", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient(); // durable defaults false — the legacy capped/ephemeral path
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));
    await waitFor(() => client.content.length >= 3);

    // On a non-durable backend the host MUST still build #log and replay it on catch_up (the broker's
    // buffer may have rolled). So the same catch_up opens the frame (to read `since`) and re-posts the log.
    client.pushInbound(inFrame("catch_up", "cu-n", JSON.stringify({ since: 0 })));
    await waitFor(() => client.content.length >= 6); // 3 live + 3 replayed
    ac.abort();
    await served;

    expect(client.opened).toContain("cu-n"); // opened to read `since` (the durable branch would not)
    // The host re-posted the whole log — proving the `if (!this.#durable)` #emit guard still POPULATES
    // #log on the non-durable path (a regression that skipped it would make this replay empty).
    expect(client.content.map((p) => p.seq)).toEqual([0, 1, 2, 0, 1, 2]);
  });
});

describe("HostRcRelay durable restart inbound safety", () => {
  it("announce publishes WITHOUT sampling the durable cursors (so it can't race a viewer bus subscribe); serve() samples before the inbound tail", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    const pushUser = vi.spyOn(session, "pushUserInput");
    const relay = relayOf(session, client);

    // The bus announce must NOT do the durable-cursor round-trip (maxSeq/frameCount) — that delay would
    // race a viewer's CONCURRENT bus subscribe in the broker (the in-process Workflow runtime rejects a
    // concurrent channel create). The cursors are sampled in serve(), before the inbound tail, instead —
    // and a viewer cannot post session-inbound faster than that local sample resolves (it must first
    // receive this announce, subscribe to the session channel, and post).
    await relay.announce("box");
    expect(client.maxSeqCalls).toBe(0);
    expect(client.frameCountCalls).toBe(0);

    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});
    await waitFor(() => client.streamStarts.length > 0);
    // serve() sampled both durable cursors before starting the inbound tail.
    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(1);

    // A live inbound arriving after the sample is delivered (exactly once).
    client.pushInbound(inFrame("user", "new-u-1", "new prompt", "new-c-1"));
    await waitFor(() => pushUser.mock.calls.length === 1);
    ac.abort();
    await served;
    expect(pushUser).toHaveBeenCalledWith("new prompt");
    expect(client.content.find((p) => p.recordKind === "user")?.text).toBe("new prompt");
  });

  it("uses server-reported durable=true even when the local backend hint is false", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.queueInbound(inFrame("user", "old-u-1", "old prompt 1", "old-c-1"));
    client.queueInbound(inFrame("user", "old-u-2", "old prompt 2", "old-c-2"));
    client.queueInbound(
      inFrame(
        "permission",
        "old-p-1",
        JSON.stringify({ request_id: "perm-old", behavior: "allow" }),
      ),
    );
    const pushUser = vi.spyOn(session, "pushUserInput");
    const pushControl = vi.spyOn(session, "pushControlResponse");
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    await waitFor(() => client.streamStarts.length > 0);
    await tick();

    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(1);
    expect(client.streamStarts[0]).toBe(3); // the three historical inbound frames are below the floor
    expect(pushUser).not.toHaveBeenCalled();
    expect(pushControl).not.toHaveBeenCalled();
    expect(client.content.filter((p) => p.recordKind === "user")).toHaveLength(0);
    expect(client.content.filter((p) => p.recordKind === "permission_resolved")).toHaveLength(0);

    client.pushInbound(inFrame("user", "new-u-1", "new prompt", "new-c-1"));
    await waitFor(() => pushUser.mock.calls.length === 1);
    ac.abort();
    await served;

    expect(pushUser).toHaveBeenCalledTimes(1);
    expect(pushUser).toHaveBeenCalledWith("new prompt");
    expect(pushControl).not.toHaveBeenCalled();
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.text).toBe("new prompt");
    expect(client.content.filter((p) => p.recordKind === "permission_resolved")).toHaveLength(0);
  });
});

// A2b/#36 (durable face) — on a durable backend the session's frames OUTLIVE the host process, so a
// restarted relay must CONTINUE the seq timeline. serve() resumes `#seq = maxSeq + 1` from the broker's
// durable log (cleartext seq column; host holds no store creds) before either pump emits — else a restart
// re-issues seqs the log already holds and a viewer's orderer drops the new content as duplicates.
describe("HostRcRelay durable seq continuity across restart (A2b/#36)", () => {
  it("resumes seq = durable MAX + 1 so a restart doesn't collide with prior frames", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.maxSeqValue = 4; // a prior incarnation already wrote seq 0..4 to the durable log
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("after restart"));
    await waitFor(() => client.content.length >= 1);
    ac.abort();
    await served;

    expect(client.maxSeqCalls).toBe(1); // queried exactly once, on serve()
    expect(client.content[0]?.seq).toBe(5); // resumed at MAX(4)+1 — NOT 0
  });

  it("starts at 0 when the durable log is empty (maxSeq null) — a fresh session", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.maxSeqValue = null;
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("first ever"));
    await waitFor(() => client.content.length >= 1);
    ac.abort();
    await served;

    expect(client.content[0]?.seq).toBe(0);
  });

  it("retries transient frameCount failures after durable=true before starting the pumps", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.frameCountFailures = 2;
    client.maxSeqValue = 4;
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("after transient failures"));
    await waitFor(() => client.content.length >= 1);
    ac.abort();
    await served;

    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(3);
    expect(client.content[0]?.seq).toBe(5);
  });

  it("uses the legacy path when the server reports non-durable", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient(); // durable false
    client.maxSeqValue = 9; // ignored because durable=false
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("legacy"));
    await waitFor(() => client.content.length >= 1);
    await waitFor(() => client.streamStarts.length > 0);
    ac.abort();
    await served;

    expect(client.maxSeqCalls).toBe(1); // capability discovery only
    expect(client.frameCountCalls).toBe(0);
    expect(client.streamStarts[0]).toBe(0);
    expect(client.content[0]?.seq).toBe(0);
  });

  it("uses the legacy path when durability discovery itself fails before durable=true is known", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.maxSeqThrows = true;
    client.maxSeqValue = 9;
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("legacy after seq error"));
    await waitFor(() => client.content.length >= 1);
    await waitFor(() => client.streamStarts.length > 0);
    ac.abort();
    await served;

    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(0);
    expect(client.streamStarts[0]).toBe(0);
    expect(client.content[0]?.seq).toBe(0);
  });

  it("fails loud after durable frameCount retries fail instead of reusing startIndex 0", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.frameCountThrows = true;
    const { tracer, errors } = spyTracer();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      tracer,
    });

    await expect(relay.serve(new AbortController().signal)).rejects.toThrow(/frameCount failed/);

    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(3);
    expect(client.content).toHaveLength(0); // no seq 0 collision is posted
    expect(
      errors.find((e) => e.msg.includes("inbound cursor resume failed after retries")),
    ).toBeDefined();
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

// #5 — coverage backfills for the documented-but-untested control-verb auth invariant, the attachment
// size cap, and the shared-seq discipline under concurrent load.
describe("HostRcRelay control-verb auth + validation (#5)", () => {
  /** Drive one inbound control frame, then a benign `user` frame that proves the relay kept running;
   *  returns the spy on session.pushControlRequest so a test can assert what (if anything) it drove. */
  async function driveVerb(verb: string, msgId: string, bodyJson: string, failAead = false) {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    if (failAead) client.failOpen.add(msgId);
    const relay = relayOf(session, client);
    const spy = vi.spyOn(session, "pushControlRequest");
    client.queueInbound(inFrame(verb, msgId, bodyJson));
    client.queueInbound(inFrame("user", `after-${msgId}`, "ok"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;
    return spy;
  }

  it("rejects a verb whose frame fails AEAD open — never drives the action (forge-proof)", async () => {
    const spy = await driveVerb("interrupt", "v-aead", JSON.stringify({}), /* failAead */ true);
    expect(spy).not.toHaveBeenCalled(); // a forged/tampered interrupt must NOT reach the worker
  });

  it("drops a STALE (expired) control verb", async () => {
    const spy = await driveVerb(
      "set_model",
      "v-stale",
      JSON.stringify({ model: "opus", expiry: 1 }),
    );
    expect(spy).not.toHaveBeenCalled(); // expiry in the distant past → no-op
  });

  it("ignores a verb with a missing required field", async () => {
    const spy = await driveVerb("set_model", "v-nomodel", JSON.stringify({})); // no `model`
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores an authenticated-but-malformed (non-object) body", async () => {
    const spy = await driveVerb("set_mode", "v-bad", "42"); // valid JSON, not an object
    expect(spy).not.toHaveBeenCalled();
  });

  it("drives a valid, fresh verb through to the worker", async () => {
    const spy = await driveVerb(
      "set_model",
      "v-ok",
      JSON.stringify({ model: "opus", expiry: Date.now() + 60_000 }),
    );
    expect(spy).toHaveBeenCalledWith("set_model", { model: "opus" });
  });
});

describe("HostRcRelay attachment size cap (#5)", () => {
  it("rejects an over-cap attachment: nothing written, nothing echoed, no seq burned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    // `data` is well-formed base64 but one char over the cap → rejected before any side effect.
    const oversized = "A".repeat(MAX_ATTACHMENT_B64 + 4);
    client.queueInbound(
      inFrame(
        "attachment",
        "big-1",
        JSON.stringify({ name: "x.png", mime: "image/png", data: oversized }),
      ),
    );
    client.queueInbound(inFrame("user", "u-1", "after"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    expect(readdirSync(dir)).toHaveLength(0); // nothing written
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1); // only the real user frame echoed
    expect(users[0]?.seq).toBe(0); // the oversized attachment burned no seq
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("HostRcRelay seq discipline under load (#5)", () => {
  it("allocates a gap-free, dup-free seq run under interleaved upstream + inbound traffic", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    // Interleave N upstream turns and N inbound prompts so both pumps allocate from the shared `#seq`.
    const N = 40;
    for (let i = 0; i < N; i++) {
      session.pushUpstream(assistant(`a${i}`));
      client.pushInbound(inFrame("user", `u${i}`, `p${i}`));
    }
    await waitFor(() => client.content.length >= 2 * N, 5000);
    ac.abort();
    await served;

    const seqs = (client.content.map((p) => p.seq) as number[]).sort((a, b) => a - b);
    expect(seqs).toHaveLength(2 * N); // every frame got a seq
    expect(new Set(seqs).size).toBe(2 * N); // …all distinct (no duplicate seq)
    expect(seqs[0]).toBe(0);
    expect(seqs[2 * N - 1]).toBe(2 * N - 1); // a contiguous 0..2N-1 run (no gap)
  });
});
