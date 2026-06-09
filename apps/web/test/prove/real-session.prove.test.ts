// PROOF (the no-gaps one): a REAL, multi-turn `claude` session driven entirely by the browser Viewer
// through the encrypted broker, with the REAL HostRelay + ClaudeStreamSession on the host side. No
// fakes anywhere. Context must persist across turns — the viewer tells claude a number in turn 1 and
// asks for it back in turn 2 — which only works if both prompts genuinely reached the same live
// claude process through the bus/session relay.
//
// Gated behind RC_PROVE_REAL_CLAUDE=1 so CI stays fast/deterministic/network-free. Run with:
//   RC_PROVE_REAL_CLAUDE=1 pnpm exec vitest run test/prove/real-session.prove.test.ts

import { deriveIdentity, formatPass } from "@remote-claw/clawsec";
import { BrokerClient, ClaudeStreamSession, HostRelay, securityProvider } from "@remote-claw/cli";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { type Message, Viewer } from "../../app/lib/viewer";
import { brokerFetch } from "../e2e/harness";

const RUN = process.env.RC_PROVE_REAL_CLAUDE === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await sleep(200);
  if (!pred()) throw new Error("timed out waiting for a condition");
}

describe.skipIf(!RUN)(
  "PROVE: a real, multi-turn claude session driven remotely through the broker",
  () => {
    afterAll(async () => {
      await teardownWorkflowTests();
    });

    it("turn 1 teaches claude a number; turn 2 reads it back — both through the encrypted broker", async () => {
      const id = await deriveIdentity(new Uint8Array(32).fill(200));
      const pass = await formatPass(id);
      const viewer = await Viewer.fromPass(pass, "http://broker", brokerFetch);
      const hostClient = new BrokerClient({
        baseUrl: "http://broker",
        provider: securityProvider("sealed", id),
        fetchFn: brokerFetch,
      });
      const sid = "live-session";
      const claude = new ClaudeStreamSession();
      const relay = new HostRelay({
        client: hostClient,
        identityId: id.identityId,
        sessionId: sid,
        backend: claude,
      });

      // The viewer's first prompt creates the session run; then the host starts serving it.
      await viewer.sendPrompt(sid, "Remember the number 42. Reply with exactly: OK");
      const serveAc = new AbortController();
      void relay.serve(serveAc.signal).catch(() => {});

      // Collect the decrypted transcript the viewer sees, live.
      const got: Message[] = [];
      const txAc = new AbortController();
      void (async () => {
        for await (const m of viewer.transcript(sid, txAc.signal)) got.push(m);
      })().catch(() => {});

      // Turn 1 completes when its result lands.
      await waitFor(() => got.some((m) => m.kind === "result"));

      // Turn 2: ask for the number back — claude only knows it from turn 1, which came via the broker.
      await viewer.sendPrompt(
        sid,
        "What number did I tell you to remember? Reply with just the number.",
      );
      await waitFor(() => got.filter((m) => m.kind === "result").length >= 2);

      serveAc.abort();
      txAc.abort();
      await claude.close();

      const assistantText = got
        .filter((m) => m.kind === "assistant")
        .map((m) => m.text)
        .join("\n");
      // The only way "42" appears in turn 2 is if turn 1's prompt reached the same live claude through
      // the encrypted bus/session relay — proving a real, stateful session end to end.
      expect(assistantText).toContain("42");
    }, 240_000);
  },
);
