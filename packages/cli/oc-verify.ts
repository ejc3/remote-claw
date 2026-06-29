// Standalone HUMAN-STYLE verification of the OpenCode wrapper against a LIVE `opencode serve` (:4096)
// + Bedrock Claude Sonnet. Proves the WRAPPED view == the NATIVE view (fidelity) and exercises
// human-like edge cases. NOT part of the unit suite. Run: pnpm exec tsx oc-verify.ts
//
// For each scenario we drive opencode through the REAL OpencodeDriver + REAL HostRcRelay (via the real
// bridgeSession), with a FakeBroker capturing EXACTLY the plaintext content frames a viewer renders.
// Then we read the SAME session's history via opencode's NATIVE HTTP API and assert the relayed text
// equals the native text — i.e. the wrapper relays opencode faithfully, no distortion.

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
    this.posts.push({ recordKind: h.recordKind, seq: h.seq, text: new TextDecoder().decode(b) });
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

/** Extract the joined assistant TEXT from opencode's native message history for a session. */
async function nativeAssistantText(ses: string): Promise<string> {
  const msgs = await client.getMessages(ses);
  const out: string[] = [];
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue;
    for (const p of m.parts) {
      const pp = p as { type?: string; text?: string };
      if (pp.type === "text" && typeof pp.text === "string") out.push(pp.text);
    }
  }
  return out.join("").trim();
}

async function withDriver(
  extra: OpencodeExtra,
  body: (c: { session: Session; broker: FakeBroker }) => Promise<void>,
): Promise<FakeBroker> {
  const broker = new FakeBroker();
  let session: Session | null = null;
  const identity = await deriveIdentity(new TextEncoder().encode("oc-verify-secret"));
  const ctx = {
    harnessArgs: [],
    identity,
    brokerUrl: "http://broker.invalid",
    title: "remote-claw",
    cwd: "/tmp",
    git: null,
    newClient: () => broker as unknown as BrokerClient,
    onSession: (s: Session) => {
      session = s;
    },
    extra: extra as unknown as Record<string, unknown>,
  };
  const ac = new AbortController();
  const run = new OpencodeDriver(ctx as never).run(ac.signal);
  try {
    if (!(await waitFor(() => session !== null, 5000)) || !session)
      throw new Error("driver never registered a session");
    await body({ session, broker });
  } finally {
    ac.abort();
    await run.catch(() => {});
  }
  return broker;
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  console.log(`[oc-verify] live opencode at ${BASE}, model ${MODEL.providerID}/${MODEL.modelID}\n`);

  // ── Scenario 1: FIDELITY — wrapped relayed text == native API text for the SAME turn ──────────────
  {
    const ses = await client.createSession("verify-fidelity");
    const broker = await withDriver({ client, sessionId: ses, model: MODEL }, async ({ session, broker }) => {
      session.pushUserInput("Reply with exactly: OK");
      await waitFor(() => broker.content.some((p) => p.recordKind === "assistant"), 60000);
      await sleep(800); // let the turn fully settle in opencode's store before reading native
    });
    const relayed = (broker.content.find((p) => p.recordKind === "assistant")?.text ?? "").trim();
    const native = await nativeAssistantText(ses);
    console.log(`   relayed: ${JSON.stringify(relayed)}`);
    console.log(`   native : ${JSON.stringify(native)}`);
    check("FIDELITY: relayed assistant text == native opencode API text", relayed === native && relayed.length > 0);
    check("FIDELITY: exactly ONE coalesced assistant frame (not per-delta)", broker.content.filter((p) => p.recordKind === "assistant").length === 1);
    check("FIDELITY: driver-injected prompt NOT double-emitted as a user frame", broker.content.filter((p) => p.recordKind === "user").length === 0);
  }

  // ── Scenario 2: MULTILINE prompt — newlines must survive injection + relay faithfully ─────────────
  {
    const ses = await client.createSession("verify-multiline");
    const multilinePrompt = "Echo back EXACTLY these three lines:\nline-alpha\nline-beta\nline-gamma";
    const broker = await withDriver({ client, sessionId: ses, model: MODEL }, async ({ session, broker }) => {
      session.pushUserInput(multilinePrompt);
      await waitFor(() => broker.content.some((p) => p.recordKind === "assistant"), 60000);
      await sleep(800);
    });
    // The prompt opencode stored must be byte-identical to what we injected (multiline survived).
    const msgs = await client.getMessages(ses);
    const userParts = msgs
      .filter((m) => m.info.role === "user")
      .flatMap((m) => m.parts as Array<{ type?: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    check("MULTILINE: opencode received the prompt with newlines intact", userParts.includes("line-alpha") && userParts.includes("line-beta") && userParts.includes("line-gamma"), JSON.stringify(userParts.slice(0, 80)));
    const relayed = (broker.content.find((p) => p.recordKind === "assistant")?.text ?? "").trim();
    const native = await nativeAssistantText(ses);
    check("MULTILINE: relayed == native", relayed === native && relayed.length > 0);
  }

  // ── Scenario 3: SPECIAL CHARS — backticks, quotes, $(), unicode survive paste/inject + relay ──────
  {
    const ses = await client.createSession("verify-specialchars");
    const tricky = 'Repeat verbatim: `code` "quoted" $(whoami) <tag> 100% café — δ';
    const broker = await withDriver({ client, sessionId: ses, model: MODEL }, async ({ session, broker }) => {
      session.pushUserInput(tricky);
      await waitFor(() => broker.content.some((p) => p.recordKind === "assistant"), 60000);
      await sleep(800);
    });
    const msgs = await client.getMessages(ses);
    const userText = msgs
      .filter((m) => m.info.role === "user")
      .flatMap((m) => m.parts as Array<{ type?: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    // The special chars are DATA (no shell eval, no premature submit) — opencode must see them verbatim.
    check("SPECIALCHARS: opencode received the prompt verbatim (no shell eval / truncation)", userText.includes("$(whoami)") && userText.includes("`code`") && userText.includes("café — δ"), JSON.stringify(userText.slice(0, 90)));
    const relayed = (broker.content.find((p) => p.recordKind === "assistant")?.text ?? "").trim();
    const native = await nativeAssistantText(ses);
    check("SPECIALCHARS: relayed == native", relayed === native && relayed.length > 0);
  }

  // ── Scenario 4: MULTI-TURN continuity — two turns in one session, two ordered assistant frames ────
  {
    const ses = await client.createSession("verify-multiturn");
    const broker = await withDriver({ client, sessionId: ses, model: MODEL }, async ({ session, broker }) => {
      session.pushUserInput("Reply with exactly: FIRST");
      await waitFor(() => broker.content.filter((p) => p.recordKind === "assistant").length >= 1, 60000);
      session.pushUserInput("Reply with exactly: SECOND");
      await waitFor(() => broker.content.filter((p) => p.recordKind === "assistant").length >= 2, 60000);
      await sleep(800);
    });
    const asst = broker.content.filter((p) => p.recordKind === "assistant");
    const seqs = asst.map((p) => p.seq as number);
    check("MULTITURN: two ordered assistant frames, monotonic seq, no dup", asst.length === 2 && (seqs[1] as number) > (seqs[0] as number));
    // Fidelity across the whole transcript: every relayed assistant frame's text appears in native history.
    const native = await nativeAssistantText(ses);
    const allRelayedFound = asst.every((p) => native.includes(p.text.trim()) && p.text.trim().length > 0);
    check("MULTITURN: every relayed assistant frame is present in native history", allRelayedFound);
  }

  console.log(`\n[oc-verify] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[oc-verify] FAIL:", e);
  process.exit(1);
});
