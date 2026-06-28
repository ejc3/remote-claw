// PROVE (the real-binary one): a REAL `claude --remote-control` session, intercepted by our MITM and
// bridged to the broker, driven from the web Viewer. This is the last leg the deterministic suites
// can't cover — the rc-spine e2e proves our MITM serves the RC worker protocol to a FAITHFUL fake
// worker, and the Phase-0 capture (phase0/mitm/captures, the MANGO test) proves the REAL binary
// routes its RC traffic through an HTTPS_PROXY MITM and speaks exactly these endpoints. This test
// closes the loop: the real binary → OUR TypeScript MITM → broker → Viewer.
//
// REQUIREMENTS (why it's gated): interactive `--remote-control` needs (1) a full claude.ai login
// (inference-only tokens can't establish RC, §9), and (2) a PTY — claude won't start an interactive
// RC session on a plain pipe. So it can't run in headless CI. Run it on a logged-in machine with:
//   RC_PROVE_REAL_CLAUDE=1 pnpm exec vitest run test/prove/real-rc.prove.test.ts
// It spawns the real claude attached to a PTY behind the MITM and asserts a session registers; if a
// PTY isn't available it fails loudly with guidance rather than silently passing.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPass } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { ensureCerts, HostRcRelay, MitmProxy, RelayCore, type Session } from "@remote-claw/cli/rc";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { type Message, Viewer } from "../../app/lib/viewer";
import { brokerFetch } from "../e2e/harness";
import { uniqueIdentity } from "../helpers";

const RUN = process.env.RC_PROVE_REAL_CLAUDE === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(pred: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await sleep(250);
  if (!pred()) throw new Error("timed out");
}

/** Spawn claude on a PTY if `node-pty` is installed, else a plain pipe (interactive RC needs a PTY —
 *  the test asserts registration, so a pipe that can't establish RC will fail loudly). */
function spawnClaudePty(args: string[], env: NodeJS.ProcessEnv): { kill: () => void } {
  try {
    // Optional dep: only present on a machine set up to run this prove. Resolved dynamically so the
    // file type-checks and the gated-off suite never needs it.
    const req = createRequire(import.meta.url);
    const pty = req("node-pty") as {
      spawn: (file: string, args: string[], o: Record<string, unknown>) => { kill: () => void };
    };
    const p = pty.spawn("claude", args, { name: "xterm-color", cols: 100, rows: 30, env });
    return { kill: () => p.kill() };
  } catch {
    const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    return { kill: () => child.kill("SIGTERM") };
  }
}

describe.skipIf(!RUN)(
  "PROVE: a real claude --remote-control through our MITM to the broker",
  () => {
    afterAll(async () => {
      await teardownWorkflowTests();
    });

    it("the real binary registers a session via the MITM, and a viewer turn round-trips", async () => {
      const id = await uniqueIdentity();
      const dir = mkdtempSync(join(tmpdir(), "rc-prove-"));
      const certs = ensureCerts(dir);
      const core = new RelayCore();
      const ac = new AbortController();
      let registered: Session | null = null;

      const hostClient = () =>
        new BrokerClient({
          baseUrl: "http://broker",
          provider: securityProvider("sealed", id),
          fetchFn: brokerFetch,
        });
      const proxy = new MitmProxy({
        port: 0,
        leafCert: certs.leafPem,
        leafKey: certs.leafKey,
        core,
        onSession: (s) => {
          registered = s;
          const relay = new HostRcRelay({
            client: hostClient(),
            identityId: id.identityId,
            sessionId: s.id,
            session: s,
          });
          void relay.announce("real claude").catch(() => {});
          void relay.serve(ac.signal).catch(() => {});
        },
      });
      await proxy.listen();

      const claude = spawnClaudePty(["--remote-control", "prove"], {
        ...process.env,
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        https_proxy: `http://127.0.0.1:${proxy.port}`,
        NODE_EXTRA_CA_CERTS: certs.caPem,
      });

      try {
        // The real binary must connect to OUR MITM and register an RC session.
        await waitFor(() => registered !== null, 60_000);
        expect(registered).not.toBeNull();
        const sid = (registered as unknown as Session).id;

        // A viewer drives a real turn through the broker and gets the real model's reply.
        const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
        const got: Message[] = [];
        void (async () => {
          for await (const m of viewer.transcript(sid, ac.signal)) got.push(m);
        })().catch(() => {});
        await viewer.sendPrompt(sid, "Reply with exactly: PROVED");
        await waitFor(() => got.some((m) => m.kind === "result"));
        const assistant = got
          .filter((m) => m.kind === "assistant")
          .map((m) => m.text)
          .join("\n");
        expect(assistant).toContain("PROVED");
      } finally {
        ac.abort();
        claude.kill();
        core.closeAll();
        await proxy.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
