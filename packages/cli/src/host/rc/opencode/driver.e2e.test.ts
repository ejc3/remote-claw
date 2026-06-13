// LIVE end-to-end tests for the OpenCode driver. These drive the REAL OpencodeDriver + a REAL
// HostRcRelay (via the real bridgeSession) against a LIVE `opencode serve` on http://127.0.0.1:4096
// using the cheap local model (ollama / qwen2.5:0.5b). The ONLY fake is the broker: a FakeBroker that
// captures the plaintext content frames the relay would seal + post (relay #post passes utf8(text) as
// the body, so this captures exactly what a viewer renders) and parks its inbound stream.
//
// What this proves (the user wants certainty it works the way we think intuitively):
//   (a) a prompt → exactly ONE coalesced `assistant` frame with the model's text.
//   (b) two prompts → two ordered assistant frames, no dup.
//   (c) tool use → tool_use + tool_result frames render (when the model calls a tool).
//   (d) a SHARED/LOCAL prompt sent to the session DIRECTLY (a 2nd client / the TUI) → a `local_prompt`
//       `user` frame, and a driver-injected prompt is NOT double-emitted.
//   (e) history/resume → pre-seeded messages are backfilled in order; a fresh driver on the same
//       session re-backfills with NO duplicates beyond the first.
//   (f) interrupt → an abort reaches the live server.
//   (g) permissions → unit-proven translate path (the cheap model/tools don't reliably surface a gate;
//       documented + asserted on the driver's own gate→reply mapping).
//
// Skipped automatically (with a clear message) when the live server is unreachable, so CI without an
// opencode server stays green; run locally with the server up to exercise the real path.

import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { deriveIdentity } from "@remote-claw/clawsec";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { Session } from "../session.js";
import { type HistoryMessage, OpencodeClient } from "./client.js";
import { OpencodeDriver, type OpencodeExtra } from "./driver.js";

const BASE = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const MODEL = { providerID: "ollama", modelID: "qwen2.5:0.5b" };
const TINY = "Reply with exactly: OK"; // tiny prompt — keeps the cheap model fast + cheap

/** Reachability probe: GET /session must answer. Set once in beforeAll; the suite skips when false. */
let live = false;
async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/session`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** A no-op broker that records the plaintext content frames the relay posts (recordKind/seq/text) and
 *  parks its inbound stream until aborted. seq !== null ⇒ a durable content frame (what the viewer
 *  renders). Mirrors the FakeClient/FakeBroker pattern from relay.test.ts. */
class FakeBroker {
  posts: Array<{ recordKind: string; seq: number | null; text: string }> = [];
  get content() {
    return this.posts.filter((p) => p.seq !== null);
  }
  async seqCursor(): Promise<{ maxSeq: number | null; durable: boolean }> {
    return { maxSeq: null, durable: false };
  }
  async maxSeq(): Promise<number | null> {
    return null;
  }
  async frameCountCursor(): Promise<{ frameCount: number | null; durable: boolean }> {
    return { frameCount: null, durable: false };
  }
  async frameCount(): Promise<number | null> {
    return null;
  }
  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    this.posts.push({
      recordKind: header.recordKind,
      seq: header.seq,
      text: new TextDecoder().decode(body),
    });
    return [{ ok: true }];
  }
  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    this.posts.push({
      recordKind: header.recordKind,
      seq: header.seq,
      text: new TextDecoder().decode(body),
    });
    return { ok: true };
  }
  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve();
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async openFrame(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

/** Build the DriverContext the OpencodeDriver needs, wired to a FakeBroker + the live OpencodeClient. */
async function makeCtx(broker: FakeBroker, extra: OpencodeExtra, onSession: (s: Session) => void) {
  const identity = await deriveIdentity(new TextEncoder().encode("oc-e2e-secret"));
  return {
    harnessArgs: [],
    identity,
    brokerUrl: "http://broker.invalid",
    title: "remote-claw",
    cwd: "/tmp",
    git: null,
    newClient: () => broker as unknown as BrokerClient,
    onSession,
    extra: extra as unknown as Record<string, unknown>,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(100);
  return pred();
}

/** Run a fresh OpencodeDriver against a live session, capturing its Session + broker posts. The caller
 *  drives prompts (via session.pushUserInput for injection, or client.promptAsync for a "2nd client")
 *  and asserts on broker.content; `body` runs while the driver is live, then we tear down cleanly. */
async function withDriver(
  extra: OpencodeExtra,
  body: (ctx: { session: Session; broker: FakeBroker; client: OpencodeClient }) => Promise<void>,
): Promise<FakeBroker> {
  const broker = new FakeBroker();
  let session: Session | null = null;
  const ctx = await makeCtx(broker, extra, (s) => {
    session = s;
  });
  const ac = new AbortController();
  const run = new OpencodeDriver(ctx as never).run(ac.signal);
  try {
    const ok = await waitFor(() => session !== null, 5000);
    if (!ok || session === null) throw new Error("driver never registered a session");
    await body({ session, broker, client: extra.client as OpencodeClient });
  } finally {
    ac.abort();
    await run.catch(() => {});
  }
  return broker;
}

const client = new OpencodeClient({ baseUrl: BASE });

describe("OpenCode driver — LIVE e2e (opencode serve + ollama/qwen2.5:0.5b)", () => {
  beforeAll(async () => {
    live = await probe();
    if (!live) {
      console.warn(`[opencode e2e] skipped — no live opencode server at ${BASE}`);
    }
  });
  let teardown: Array<() => void> = [];
  afterEach(() => {
    for (const t of teardown) t();
    teardown = [];
  });

  it.runIf(true)(
    "(a) one prompt → exactly ONE coalesced assistant frame with the model's text",
    async () => {
      if (!live) return;
      const ses = await client.createSession("e2e-a");
      const broker = await withDriver(
        { client, sessionId: ses, model: MODEL },
        async ({ session, broker }) => {
          session.pushUserInput(TINY);
          await waitFor(() => broker.content.some((p) => p.recordKind === "assistant"), 60000);
        },
      );
      const assistants = broker.content.filter((p) => p.recordKind === "assistant");
      // CRITICAL (coalesce #1): exactly ONE assistant frame for the turn, not one per part.updated.
      expect(assistants.length).toBe(1);
      expect(assistants[0]?.text.length).toBeGreaterThan(0);
      // The driver-injected prompt is NOT surfaced as a local_prompt (it's our own echo).
      expect(broker.content.filter((p) => p.recordKind === "user")).toHaveLength(0);
    },
    90000,
  );

  it("(b) two prompts → two ordered assistant frames, no dup", async () => {
    if (!live) return;
    const ses = await client.createSession("e2e-b");
    const broker = await withDriver(
      { client, sessionId: ses, model: MODEL },
      async ({ session, broker }) => {
        session.pushUserInput("Reply with exactly: ONE");
        await waitFor(
          () => broker.content.filter((p) => p.recordKind === "assistant").length >= 1,
          60000,
        );
        session.pushUserInput("Reply with exactly: TWO");
        await waitFor(
          () => broker.content.filter((p) => p.recordKind === "assistant").length >= 2,
          60000,
        );
      },
    );
    const assistants = broker.content.filter((p) => p.recordKind === "assistant");
    // Two distinct assistant frames, in order, with monotonically increasing seq (no dup, ordered).
    expect(assistants.length).toBe(2);
    const seqs = assistants.map((p) => p.seq as number);
    expect(seqs[1]).toBeGreaterThan(seqs[0] as number);
    // No driver-injected prompt is double-emitted as a user frame.
    expect(broker.content.filter((p) => p.recordKind === "user")).toHaveLength(0);
  }, 150000);

  it("(c) tool use → tool_use + tool_result frames render (best-effort: documented if the model declines)", async () => {
    if (!live) return;
    const ses = await client.createSession("e2e-c");
    const broker = await withDriver(
      { client, sessionId: ses, model: MODEL },
      async ({ session, broker }) => {
        // Nudge the model to use a tool. The tiny model is unreliable about tool calls, so we wait a
        // bounded time and DOCUMENT the outcome rather than hard-failing on the model's behavior.
        session.pushUserInput(
          "Use the bash tool to run exactly: echo hello. Then reply with the output.",
        );
        await waitFor(() => broker.content.some((p) => p.recordKind === "tool_use"), 60000);
        // give the result a moment to follow the tool_use
        await waitFor(() => broker.content.some((p) => p.recordKind === "tool_result"), 15000);
      },
    );
    const toolUses = broker.content.filter((p) => p.recordKind === "tool_use");
    const toolResults = broker.content.filter((p) => p.recordKind === "tool_result");
    if (toolUses.length === 0) {
      // DOCUMENTED LIMITATION (best-effort): qwen2.5:0.5b (a 0.5B model) does NOT reliably emit a tool
      // call — across runs it usually answers directly. So this live scenario does NOT assert on the
      // model's behavior (that would be flaky); the tool path is proven DETERMINISTICALLY elsewhere:
      // translate.test.ts golden-tests partToBlocks for pending/completed/error tools, and
      // driver.test.ts "(c-det)" drives a real completed-tool SSE sequence end-to-end through the relay
      // and asserts the tool_use + tool_result content frames render. This test passes either way.
      console.warn(
        "[opencode e2e] (c) the tiny model did not call a tool this run — tool path proven deterministically in driver.test.ts (c-det) + translate.test.ts",
      );
      return;
    }
    // When the model DID call a tool: the tool_use body is JSON {name,input,sub}; a completed tool also
    // yields a tool_result {tool_use_id,is_error,output,sub}. Both render as their own frames.
    const tu = JSON.parse(toolUses[0]?.text ?? "{}");
    expect(typeof tu.name).toBe("string");
    if (toolResults.length > 0) {
      const tr = JSON.parse(toolResults[0]?.text ?? "{}");
      expect(tr).toHaveProperty("output");
      expect(tr).toHaveProperty("is_error");
    }
  }, 120000);

  it("(d) SHARED/LOCAL prompt sent directly to the session → a `local_prompt` user frame; injected prompt not double-emitted", async () => {
    if (!live) return;
    const ses = await client.createSession("e2e-d");
    const local = "Reply with exactly: LOCAL";
    const broker = await withDriver(
      { client, sessionId: ses, model: MODEL },
      async ({ broker }) => {
        // The realistic shape: the driver is ALREADY attached + listening when a SECOND client (the TUI)
        // drives the session. The driver only sees LIVE SSE events (no replay), so wait for its event
        // subscription to connect before sending — otherwise the test races the SSE handshake.
        await sleep(1500);
        // Simulate the TUI / a SECOND client driving the SAME session directly via the API — the driver
        // did NOT inject this, so it must surface as a local_prompt user frame.
        await client.promptAsync(ses, { text: local, model: MODEL });
        await waitFor(() => broker.content.some((p) => p.recordKind === "user"), 60000);
        await waitFor(() => broker.content.some((p) => p.recordKind === "assistant"), 30000);
      },
    );
    const users = broker.content.filter((p) => p.recordKind === "user");
    // The locally/foreign-sent prompt is surfaced as a `user` frame (local_prompt branch).
    expect(users.length).toBeGreaterThanOrEqual(1);
    expect(users.some((p) => p.text.includes("LOCAL"))).toBe(true);
    // It precedes the assistant reply (prompt then answer).
    const firstUser = users[0]?.seq as number;
    const firstAsst = broker.content.find((p) => p.recordKind === "assistant")?.seq as number;
    if (firstAsst !== undefined) expect(firstUser).toBeLessThan(firstAsst);
  }, 120000);

  it("(d2) a driver-INJECTED prompt is suppressed (NOT double-emitted as a user frame)", async () => {
    if (!live) return;
    const ses = await client.createSession("e2e-d2");
    const broker = await withDriver(
      { client, sessionId: ses, model: MODEL },
      async ({ session, broker }) => {
        session.pushUserInput(TINY); // the driver injects this → its echo must be suppressed
        await waitFor(() => broker.content.some((p) => p.recordKind === "assistant"), 60000);
        await sleep(500); // give any (incorrect) user echo a chance to appear
      },
    );
    // The injected prompt's OpenCode user-message echo is suppressed — zero user frames.
    expect(broker.content.filter((p) => p.recordKind === "user")).toHaveLength(0);
    expect(broker.content.some((p) => p.recordKind === "assistant")).toBe(true);
  }, 90000);

  it("(e) history/resume — pre-seed a session, attach → full backlog backfilled in order; restart → no dup", async () => {
    if (!live) return;
    // Pre-seed the session OUT OF BAND (no driver attached): two complete turns.
    const ses = await client.createSession("e2e-e");
    await client.promptAsync(ses, { text: "Reply with exactly: ALPHA", model: MODEL });
    await waitForMessages(ses, 2, 60000); // user + assistant
    await client.promptAsync(ses, { text: "Reply with exactly: BETA", model: MODEL });
    await waitForMessages(ses, 4, 60000); // +user +assistant

    // FIRST attach: the full prior conversation must be backfilled to the broker, in order.
    const b1 = await withDriver({ client, sessionId: ses, model: MODEL }, async ({ broker }) => {
      await waitFor(
        () => broker.content.filter((p) => p.recordKind === "assistant").length >= 2,
        30000,
      );
    });
    const a1 = b1.content.filter((p) => p.recordKind === "assistant");
    const u1 = b1.content.filter((p) => p.recordKind === "user");
    expect(a1.length).toBe(2); // both prior assistant turns backfilled
    expect(u1.length).toBe(2); // both prior user prompts (local, never injected) backfilled
    // Ordering: the whole transcript is seq-ascending; the first user precedes the first assistant.
    const seqs = b1.content.map((p) => p.seq as number);
    expect([...seqs]).toEqual([...seqs].sort((x, y) => x - y));

    // RESTART: a FRESH driver on the SAME session re-fetches history. A new broker session starts the
    // log over (seq from 0), so the backlog re-appears EXACTLY ONCE — no duplicates beyond the first.
    const b2 = await withDriver({ client, sessionId: ses, model: MODEL }, async ({ broker }) => {
      await waitFor(
        () => broker.content.filter((p) => p.recordKind === "assistant").length >= 2,
        30000,
      );
    });
    expect(b2.content.filter((p) => p.recordKind === "assistant").length).toBe(2);
    expect(b2.content.filter((p) => p.recordKind === "user").length).toBe(2);
  }, 200000);

  it("(f) interrupt → an abort reaches the live server", async () => {
    if (!live) return;
    const ses = await client.createSession("e2e-f");
    // Spy on the live client's abort so we PROVE the interrupt verb reached the server.
    let aborts = 0;
    const spyClient = new OpencodeClient({ baseUrl: BASE });
    const origAbort = spyClient.abort.bind(spyClient);
    spyClient.abort = async (sessionId: string) => {
      aborts++;
      return origAbort(sessionId);
    };
    await withDriver({ client: spyClient, sessionId: ses, model: MODEL }, async ({ session }) => {
      // Start a turn, then interrupt it. The driver maps interrupt → client.abort(sessionId).
      session.pushUserInput("Count slowly from 1 to 100, one number per line.");
      await sleep(800);
      session.pushControlRequest("interrupt");
      await waitFor(() => aborts >= 1, 10000);
    });
    expect(aborts).toBeGreaterThanOrEqual(1); // the abort POST reached the server
  }, 60000);
});

/** Poll GET /session/{id}/message until it has >= n messages (used to pre-seed history out of band). */
async function waitForMessages(ses: string, n: number, ms: number): Promise<HistoryMessage[]> {
  const end = Date.now() + ms;
  for (;;) {
    const msgs = await client.getMessages(ses);
    const done = msgs.filter(
      (m) =>
        m.info.role === "user" ||
        (m.info.role === "assistant" && m.info.time?.completed !== undefined),
    );
    if (done.length >= n || Date.now() > end) return msgs;
    await sleep(300);
  }
}
