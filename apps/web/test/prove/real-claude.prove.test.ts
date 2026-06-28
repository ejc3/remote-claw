// PROOF: a REAL, logged-in `claude` driven end-to-end through the whole remote-claw stack — the
// browser Viewer's transport ↔ the real broker (in-process Workflow runtime) ↔ a host that runs the
// real `claude -p` as its model. Everything is E2E-encrypted; the broker sees only ciphertext.
//
// Gated behind RC_PROVE_REAL_CLAUDE=1 so CI stays fast/deterministic and network-free. Run it with:
//   RC_PROVE_REAL_CLAUDE=1 pnpm exec vitest run test/prove/real-claude.prove.test.ts

import { spawn } from "node:child_process";
import { formatPass, utf8 } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { Viewer } from "../../app/lib/viewer";
import { brokerFetch, header, takeFrames } from "../e2e/harness";
import { uniqueIdentity } from "../helpers";

const RUN = process.env.RC_PROVE_REAL_CLAUDE === "1";
const td = new TextDecoder();

/** Run the real, logged-in claude headlessly and return its answer. */
function realClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`claude exited ${code}: ${err}`)),
    );
  });
}

/** First value from an async generator (then stop). */
async function first<T>(gen: AsyncGenerator<T>): Promise<T> {
  for await (const x of gen) return x;
  throw new Error("generator produced nothing");
}

describe.skipIf(!RUN)("PROVE: a real claude, driven end-to-end through the broker", () => {
  afterAll(async () => {
    await teardownWorkflowTests();
  });

  it("viewer prompt → broker → host → REAL claude → broker → viewer (encrypted throughout)", async () => {
    const id = await uniqueIdentity();
    const pass = await formatPass(id);
    const viewer = await Viewer.fromPass(pass, "http://broker", brokerFetch);
    const host = new BrokerClient({
      baseUrl: "http://broker",
      provider: securityProvider("sealed", id),
      fetchFn: brokerFetch,
    });
    const sid = "real-1";

    // The host announces the session; the browser viewer discovers it (decrypted under K_meta).
    await host.postFrame(
      header(id, { recordKind: "session_announce", sessionId: sid, msgId: "ann" }),
      utf8(JSON.stringify({ session_id: sid, title: "real claude", sent_at: Date.now() })),
    );
    expect((await first(viewer.announces(new AbortController().signal))).title).toBe("real claude");

    // The viewer sends a real prompt; it travels encrypted to the host.
    const prompt = "What is the capital of France? Reply with one word.";
    await viewer.sendPrompt(sid, prompt);

    // The host receives + decrypts the prompt and runs the REAL claude as its model.
    const [userIn] = await takeFrames(
      host.streamFrames({ session: sid, startIndex: 0 }),
      1,
      (f) => f.dir === "in",
    );
    if (userIn === undefined) throw new Error("host saw no prompt");
    const gotPrompt = td.decode(await host.openFrame(userIn));
    expect(gotPrompt).toBe(prompt);
    const answer = await realClaude(gotPrompt);
    console.log(
      `\n  REAL CLAUDE (through the encrypted broker) answered: ${JSON.stringify(answer)}\n`,
    );

    // The host relays claude's answer back; the viewer decrypts + renders it.
    await host.postFrame(
      header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId: "as" }),
      utf8(answer),
    );
    const reply = await first(viewer.transcript(sid, new AbortController().signal));
    expect(reply.kind).toBe("assistant");
    expect(reply.text.toLowerCase()).toContain("paris");
  }, 180_000);
});
