// The e2e HOST — run as a real, persistent process (spawned via tsx by the seedHost fixture), pointed at
// the target broker (the local webServer, or the deployed preview URL + SSO bypass). This is the SAME
// host the production wrapper runs (real Session + HostRcRelay + serve()); the ONLY fake is the worker
// leg, which we script by pushing a canned RC turn instead of bridging a live claude. Running it here
// (a persistent Node process) instead of inside a serverless route is what makes the preview e2e reliable
// AND full-featured: serve() stays alive for the whole test, so it both PUBLISHES the scripted turn and
// ECHOES the browser's LIVE prompts (typed echo / permission grant / AskUserQuestion answer / attachment)
// — exactly the production shape, coordinating with the browser through the broker.
//
// Protocol with the spawner (fixtures.ts): config comes in via RC_E2E_* env; once the scripted frames are
// durably published, we print one JSON line `{"pass":…,"sessionId":…}` to stdout (all logs go to stderr);
// then we run serve() until SIGTERM/SIGINT aborts it or the fixture closes the real Session over stdin.

import { createInterface } from "node:readline";
import { deriveIdentity, formatPass } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import {
  CLAUDE_NATIVE_CAPABILITIES,
  CLAUDE_NATIVE_HARNESS,
  type DriverCapabilities,
  type HarnessDescriptor,
  HostRcRelay,
  MITM_CAPABILITIES,
  MITM_HARNESS,
  OPENCODE_HARNESS,
  Session,
  STABLE_MITM_CAPABILITIES,
  TMUX_HARNESS,
  tmuxCapabilities,
} from "@remote-claw/cli/rc";
import { scenario, smokeScenario } from "./scenario.js";

/** Which harness the announce declares (RC_E2E_HARNESS), so the agent+mode badge (#164) can be exercised
 * end-to-end without each real harness. Unset is the private MITM relay. */
function presetHarness(p: string | undefined): HarnessDescriptor {
  if (p === "native-rc") return CLAUDE_NATIVE_HARNESS;
  if (p === "tmux") return TMUX_HARNESS;
  if (p === "opencode") return OPENCODE_HARNESS;
  return MITM_HARNESS;
}

/** Capability presets the browser e2e can drive (RC_E2E_CAPS) so the capability-gated viewer (#149) can be
 * exercised end-to-end without each real harness. Unset is the shipped private-relay Claude tuple;
 * maximal MITM plumbing is deliberately opt-in as `compat-mitm`. */
function presetCaps(p: string | undefined): DriverCapabilities {
  if (p === "compat-mitm") return MITM_CAPABILITIES;
  if (p === "native-rc") return CLAUDE_NATIVE_CAPABILITIES;
  // Explicitly choose the default READY posture. The driver itself starts conservative and publishes
  // this tuple only after its permission hook is proved ready; a static pre-ready constant previously
  // let this fixture silently advertise the wrong permission posture.
  if (p === "tmux") return tmuxCapabilities(true);
  if (p === "opencode")
    // Exact supported OpenCode default: permission interaction remains native/local, status is not
    // claimed without an initial snapshot, and only plain text + interrupt cross the viewer boundary.
    return {
      structuredPermissions: false,
      status: false,
      controls: { interrupt: true, setModel: false, setMode: false, end: false },
      attachments: false,
    };
  return STABLE_MITM_CAPABILITIES;
}

const base = process.env.RC_E2E_BASE;
if (!base) {
  console.error("[host-runner] RC_E2E_BASE (the broker URL) is required");
  process.exit(2);
}
const backend = process.env.RC_E2E_BACKEND || undefined; // ?backend= equivalent; unset ⇒ deployment default
const bypass = process.env.RC_E2E_BYPASS || undefined; // VERCEL_AUTOMATION_BYPASS_SECRET for the preview SSO
const withPerm = process.env.RC_E2E_PERM === "1";
const askqMode = process.env.RC_E2E_ASKQ; // "1" (single-select) | "multi" (multiSelect) | unset
const withAskq = askqMode === "1" || askqMode === "multi";
const askqMulti = askqMode === "multi";
const smoke = process.env.RC_E2E_PROFILE === "smoke";

// A fresh random identity per host so each test gets isolated bus/session channels.
const secret = new Uint8Array(32);
crypto.getRandomValues(secret);
const id = await deriveIdentity(secret);
const pass = await formatPass(id);
const rand = new Uint8Array(8);
crypto.getRandomValues(rand);
const sessionId = `e2e-${Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("")}`;

const session = new Session(sessionId, "rc box", {});
const clientOpts: ConstructorParameters<typeof BrokerClient>[0] = {
  baseUrl: base,
  provider: securityProvider("sealed", id),
};
if (backend) clientOpts.backend = backend;
if (bypass) clientOpts.protectionBypass = bypass;
const client = new BrokerClient(clientOpts);
const caps = presetCaps(process.env.RC_E2E_CAPS); // unset ⇒ exact stable Claude tuple
const harness = presetHarness(process.env.RC_E2E_HARNESS); // agent+mode badge (#164); unset ⇒ MITM
const relay = new HostRcRelay({
  client,
  identityId: id.identityId,
  sessionId,
  session,
  harness,
  capabilities: caps,
});

const ac = new AbortController();
const commands = createInterface({ input: process.stdin });
commands.on("line", (line) => {
  if (line.trim() === "terminal") {
    session.close();
    void relay.terminalizePresence().then(
      () => process.stdout.write(`${JSON.stringify({ terminal: true, sessionId })}\n`),
      () => process.stdout.write(`${JSON.stringify({ terminal: false, sessionId })}\n`),
    );
  }
});
const stop = () => {
  ac.abort();
  // Force-exit if serve() doesn't unwind + release its handles promptly after the abort — we OVERRODE the
  // default SIGTERM (to abort cleanly), so without this the process could linger as a zombie. unref'd so it
  // never itself keeps the process alive.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// Announce + queue the scripted turn. A failure here (unreachable broker / bad auth / SSO wall) must exit
// CLEANLY with a legible message — not crash as an unhandled rejection — so the fixture sees a clear
// "host exited" instead of a stack dump. (announce is the first network call, so it catches most misconfig.)
try {
  // Match the production bridge's safety barrier: sample and validate the durable inbound/outbound
  // cursors before the bus announce makes this session discoverable. Announce-before-prepare creates a
  // window in which a browser command can land and then be skipped as historical by serve().
  await relay.prepare();
  // A FIXED git snapshot (deterministic git chip, #49) — not the deployment's real repo.
  await relay.announce("rc box", "/home/ubuntu/remote-claw", {
    branch: "main",
    sha: "abc1234",
    dirty: true,
    ahead: 2,
    behind: 0,
  });
  for (const payload of smoke ? smokeScenario() : scenario(withPerm, withAskq, askqMulti)) {
    session.pushUpstream(payload);
  }
} catch (e) {
  console.error(`[host-runner] announce/seed failed (base=${base}):`, e);
  process.exit(2);
}

// Run the relay (drains the queued turn → publishes the frames, then serves LIVE inbound forever).
let ready = false;
const serving = relay.serve(ac.signal).catch((e) => {
  if (ac.signal.aborted) return; // normal teardown — SIGTERM aborted the relay
  console.error(`[host-runner] serve(${sessionId}) failed:`, e);
  // A non-aborted serve() rejection is TERMINAL — the host can no longer publish or echo. Always exit
  // non-zero so a dead host is never silently green: before readiness (exit 2) the fixture rejects the test
  // setup; after readiness (exit 1) the live host is gone, surfaced as a dead host rather than a mysterious
  // echo timeout in whatever live round-trip the browser was driving.
  process.exit(ready ? 1 : 2);
});

// Wait until the scripted frames are durably published before signalling readiness — but ONLY the
// per-channel SQLite/Turso backend reports durable (it's the only one with a slow, lazy channel DB
// create where the browser could momentarily see "no such channel"). For local/vercel this is a no-op:
// there's no frameCount to poll, and none is needed — the persistent host pump publishes the turn
// immediately and keeps serving, and the browser subscribes to the LIVE transcript stream, so it receives
// every frame within its expect window regardless. (This is categorically unlike the old seed route, whose
// after()-deferred publish could never land at all.)
if (!(await waitForSeededFrames(client, sessionId))) {
  // Stable durable readiness is a release precondition, not advisory evidence. Never print the ready
  // line after a timeout: doing so lets the browser exercise a half-published fixture and go green.
  console.error(`[host-runner] frames not confirmed durable within the wait window (${sessionId})`);
  ac.abort();
  await serving;
  await relay.settlePresence();
  commands.close();
  process.exit(2);
}
ready = true; // past here a serve() failure is mid-test (exit 1), not a setup failure (exit 2) — see catch
process.stdout.write(`${JSON.stringify({ pass, sessionId })}\n`);

await serving; // keep the host alive (serving LIVE inbound) until SIGTERM/SIGINT
await relay.settlePresence(); // do not let the child exit before its terminal tombstone is published
commands.close();

/** Poll until the seeded turn's content frames are durably published — count > 0 and stable across a few
 *  polls — or a bounded timeout. Gates on the cursor's `durable` flag, not a null count: a durable backend
 *  returns frameCount:null for a channel that doesn't exist yet, so on a cold path the first poll is null
 *  and we MUST keep waiting. Only the per-channel SQLite/Turso backend implements frameCount/maxSeq, so it
 *  is the only one that reports durable:true; local/vercel report durable:false and expose NO
 *  frameCount to poll, so we don't wait — the persistent host pump publishes the turn immediately and the
 *  browser streams it live (any sub-second gap is absorbed by its expect window). Never throws. Returns
 *  true when settled (durable-stable, or non-durable so no wait is possible/needed), false on a timeout. */
async function waitForSeededFrames(c: BrokerClient, sid: string): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  const pollMs = 200;
  const stableTarget = 4;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    let cursor: { frameCount: number | null; durable: boolean } | null = null;
    try {
      cursor = await c.frameCountCursor(sid);
    } catch {
      // transient broker error mid-publish — keep polling
    }
    if (cursor !== null) {
      if (!cursor.durable) return true; // non-durable (local): no frameCount to poll; browser streams it
      const count = cursor.frameCount ?? 0; // durable: null/0 = channel not populated yet → keep waiting
      if (count > 0 && count === last) {
        if (++stable >= stableTarget) return true;
      } else {
        stable = 0;
        last = count;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false; // timed out — caller warns; the browser's own assertion window is the hard backstop
}
