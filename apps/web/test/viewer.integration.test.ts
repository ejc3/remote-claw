import { deriveIdentity, formatPass, type Identity, utf8 } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { Viewer } from "../app/lib/viewer";
import { brokerFetch, header } from "./e2e/harness";

afterAll(async () => {
  await teardownWorkflowTests();
});

const never = new AbortController().signal;

/** Read up to `n` values from an async generator, then stop (break cancels the live stream). */
async function takeGen<T>(gen: AsyncGenerator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

/** A minimal fake host driven by the same transport, for the viewer to talk to. */
function fakeHost(id: Identity): BrokerClient {
  return new BrokerClient({
    baseUrl: "http://broker",
    provider: securityProvider("sealed", id),
    fetchFn: brokerFetch,
  });
}

describe("web client Viewer (browser-safe, against the real broker)", () => {
  it("loads a pass, discovers a session on the bus, sends a prompt, and renders the reply", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(77));
    const pass = await formatPass(id);
    const viewer = await Viewer.fromPass(pass, "http://broker", brokerFetch);
    const host = fakeHost(id);
    const sid = "sess-web";

    // The host announces the session on the bus; the viewer discovers it (decrypted under K_meta).
    await host.postFrame(
      header(id, { recordKind: "session_announce", sessionId: sid, msgId: "ann-w" }),
      utf8(JSON.stringify({ session_id: sid, title: "web box", cwd: "/srv/app", sent_at: 1 })),
    );
    const [discovered] = await takeGen(viewer.announces(never), 1);
    expect(discovered).toMatchObject({ sessionId: sid, title: "web box", cwd: "/srv/app" });

    // The viewer sends a prompt; the host receives it on the session channel and decrypts it.
    const text = "hello from the browser";
    await viewer.sendPrompt(sid, text);
    const [prompt] = await takeGen(host.streamFrames({ session: sid, startIndex: 0 }), 1);
    if (prompt === undefined) throw new Error("host saw no prompt");
    expect(prompt.dir).toBe("in");
    expect(prompt.recordKind).toBe("user");
    const got = new TextDecoder().decode(await host.openFrame(prompt));
    expect(got).toBe(text);

    // The host replies on the session out-stream; the viewer's transcript renders it in order.
    await host.postFrame(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "as-w" }),
      utf8(`you said: ${got}`),
    );
    await host.postFrame(
      header(id, { recordKind: "result", sessionId: sid, seq: 1, msgId: "re-w" }),
      utf8(JSON.stringify({ ok: true })),
    );
    const msgs = await takeGen(viewer.transcript(sid, never), 2);
    expect(msgs.map((m) => m.kind)).toEqual(["assistant", "result"]);
    expect(msgs[0]?.text).toBe("you said: hello from the browser");
  });

  it("reassembles a LARGE assistant message (split into chunks) through the viewer's reorder path", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(99));
    const pass = await formatPass(id);
    const viewer = await Viewer.fromPass(pass, "http://broker", brokerFetch);
    const host = fakeHost(id);
    const sid = "big-view";
    // ~18 KB assistant reply, posted as chunks (8 KB) sharing one seq — the host's real path.
    const big = "lorem ipsum dolor ".repeat(1000);
    await host.postMessage(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "big-assistant" }),
      utf8(big),
      8000,
    );
    // The viewer must surface it as ONE message (FrameOrderer holds the seq until all parts land,
    // then openMessage reassembles) — not as fragments or a dropped tail.
    const [msg] = await takeGen(viewer.transcript(sid, never), 1);
    expect(msg?.kind).toBe("assistant");
    expect(msg?.text).toBe(big);
  });

  it("rejects a malformed pass with a clear error", async () => {
    await expect(Viewer.fromPass("not-a-pass", "http://broker", brokerFetch)).rejects.toThrow();
  });
});
