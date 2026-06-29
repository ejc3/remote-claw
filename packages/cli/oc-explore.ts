// Exploratory edge-case probes for the OpenCode wrapper (live :4096 + Bedrock Claude Sonnet). These target the gaps a
// scenario-discovery workflow flagged: doc-vs-impl divergences (/compact routing, session.error
// surfacing), the server-wide /event filter under TWO concurrent drivers (cross-session leak?), and the
// whitespace-only prompt burn. PROBES (not pass/fail asserts) — they print ground truth so we can make
// the docs honest + fix the cheap bugs. Run: pnpm exec tsx oc-explore.ts

import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { deriveIdentity } from "@remote-claw/clawsec";
import type { BrokerClient } from "./src/broker/client.js";
import { OpencodeClient } from "./src/host/rc/opencode/client.js";
import { OpencodeDriver, type OpencodeExtra } from "./src/host/rc/opencode/driver.js";
import type { Session } from "./src/host/rc/session.js";

const BASE = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const MODEL = { providerID: "amazon-bedrock", modelID: "global.anthropic.claude-sonnet-4-6" };
const client = new OpencodeClient({ baseUrl: BASE });

class FakeBroker {
  posts: Array<{ recordKind: string; seq: number | null; text: string }> = [];
  announces: Record<string, unknown>[] = [];
  get content() {
    return this.posts.filter((p) => p.seq !== null);
  }
  async seqCursor() {
    return { maxSeq: null, durable: false };
  }
  async frameCountCursor() {
    return { frameCount: null, durable: false };
  }
  async postMessage(h: FrameHeader, b: Uint8Array) {
    this.posts.push({ recordKind: h.recordKind, seq: h.seq, text: new TextDecoder().decode(b) });
    return [{ ok: true }];
  }
  async postFrame(h: FrameHeader, b: Uint8Array) {
    const text = new TextDecoder().decode(b);
    if (h.recordKind === "session_announce") {
      try {
        this.announces.push(JSON.parse(text));
      } catch {}
    }
    this.posts.push({ recordKind: h.recordKind, seq: h.seq, text });
    return { ok: true };
  }
  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    await new Promise<void>((r) => {
      if (opts.signal?.aborted) return r();
      opts.signal?.addEventListener("abort", () => r(), { once: true });
    });
  }
  async openFrame() {
    return new Uint8Array();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(100);
  return pred();
}

async function startDriver(extra: OpencodeExtra): Promise<{
  session: Session;
  broker: FakeBroker;
  stop: () => Promise<void>;
}> {
  const broker = new FakeBroker();
  let session: Session | null = null;
  const identity = await deriveIdentity(new TextEncoder().encode("oc-explore"));
  const ctx = {
    harnessArgs: [], identity, brokerUrl: "http://broker.invalid", title: "remote-claw",
    cwd: "/tmp", git: null, newClient: () => broker as unknown as BrokerClient,
    onSession: (s: Session) => {
      session = s;
    },
    extra: extra as unknown as Record<string, unknown>,
  };
  const ac = new AbortController();
  const run = new OpencodeDriver(ctx as never).run(ac.signal);
  if (!(await waitFor(() => session !== null, 5000)) || !session)
    throw new Error("driver never registered");
  return {
    session,
    broker,
    stop: async () => {
      ac.abort();
      await run.catch(() => {});
    },
  };
}

async function userBodies(ses: string): Promise<string[]> {
  const msgs = await client.getMessages(ses);
  return msgs
    .filter((m) => m.info.role === "user")
    .flatMap((m) => (m.parts as Array<{ type?: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text ?? ""));
}

async function main() {
  console.log(`[oc-explore] live opencode ${BASE}\n`);

  // ── PROBE 1: /compact slash command — does it route to summarize, or hit the model as literal text? ──
  {
    const ses = await client.createSession("explore-compact");
    const d = await startDriver({ client, sessionId: ses, model: MODEL });
    d.session.pushUserInput("/compact");
    await waitFor(() => d.broker.content.length > 0, 30000);
    await sleep(1500);
    await d.stop();
    const bodies = await userBodies(ses);
    console.log("PROBE 1 /compact:");
    console.log("  stored user message bodies:", JSON.stringify(bodies));
    console.log("  → divergence if '/compact' is stored as a literal user prompt (no summarize routing)");
    console.log("  broker frames:", d.broker.content.map((p) => p.recordKind).join(",") || "(none)");
  }

  // ── PROBE 2: session.error — drive a turn with a NONEXISTENT model; does an error frame reach the viewer? ──
  {
    const ses = await client.createSession("explore-error");
    const badModel = {
      providerID: "amazon-bedrock",
      modelID: "global.anthropic.this-model-does-not-exist-zzz",
    };
    const d = await startDriver({ client, sessionId: ses, model: badModel });
    d.session.pushUserInput("Reply with: X");
    // Wait for SOMETHING (an error frame, an assistant frame, or a timeout).
    await waitFor(() => d.broker.content.length > 0, 20000);
    await sleep(2000);
    await d.stop();
    console.log("\nPROBE 2 session.error (bad model):");
    console.log("  broker frames:", d.broker.content.map((p) => `${p.recordKind}:${JSON.stringify(p.text.slice(0, 40))}`).join(" | ") || "(NONE — silent failure)");
    console.log("  → divergence if NO error/result frame reaches the viewer (doc promises session.error surfaces)");
  }

  // ── PROBE 3: two drivers on the SAME server (server-wide /event) — does A leak into B? ──
  {
    const sesA = await client.createSession("explore-A");
    const sesB = await client.createSession("explore-B");
    const a = await startDriver({ client, sessionId: sesA, model: MODEL });
    const b = await startDriver({ client, sessionId: sesB, model: MODEL });
    await sleep(1200); // let both SSE subscriptions connect
    a.session.pushUserInput("Reply with exactly: ALPHA");
    b.session.pushUserInput("Reply with exactly: BETA");
    await waitFor(() => a.broker.content.some((p) => p.recordKind === "assistant") && b.broker.content.some((p) => p.recordKind === "assistant"), 60000);
    await sleep(1000);
    await a.stop();
    await b.stop();
    const aText = a.broker.content.filter((p) => p.recordKind === "assistant").map((p) => p.text).join(" ");
    const bText = b.broker.content.filter((p) => p.recordKind === "assistant").map((p) => p.text).join(" ");
    console.log("\nPROBE 3 two-driver cross-talk (server-wide /event filter):");
    console.log("  driver A assistant text:", JSON.stringify(aText));
    console.log("  driver B assistant text:", JSON.stringify(bText));
    const leak = aText.includes("BETA") || bText.includes("ALPHA");
    console.log(`  → ${leak ? "❌ LEAK — cross-session content crossed over!" : "✅ ISOLATED — each viewer saw only its own session"}`);
  }

  // ── PROBE 4: whitespace-only prompt — does "   " burn a real turn? ──
  {
    const ses = await client.createSession("explore-ws");
    const d = await startDriver({ client, sessionId: ses, model: MODEL });
    d.session.pushUserInput("   ");
    await sleep(6000); // give a (wrongly) created turn time to appear
    await d.stop();
    const bodies = await userBodies(ses);
    const asst = d.broker.content.filter((p) => p.recordKind === "assistant").length;
    console.log("\nPROBE 4 whitespace-only prompt:");
    console.log("  stored user bodies:", JSON.stringify(bodies));
    console.log("  assistant frames produced:", asst);
    console.log(`  → ${bodies.length > 0 || asst > 0 ? "burns a turn (non-empty-but-blank passes the empty-string guard)" : "no-op (guarded)"}`);
  }

  console.log("\n[oc-explore] done");
}

main().catch((e) => {
  console.error("[oc-explore] FAIL:", e);
  process.exit(1);
});
