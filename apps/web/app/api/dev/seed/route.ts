import { deriveIdentity, formatPass } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { HostRcRelay, Session } from "@remote-claw/cli/rc";
import { after } from "next/server";
import { gate } from "./gate";

// Seed route for the Playwright app e2e. Enabled in two ways, NEVER in production:
//   • LOCAL dev/CI — BROKER_BACKEND=local and not on Vercel (the local + temporal e2e).
//   • Vercel PREVIEW — a matching `x-dev-seed-token` (the DEV_SEED_TOKEN secret) on a non-production
//     deploy, so the UI e2e can run against a preview on the vercel backend. Inert in prod (no token
//     honoured when VERCEL_ENV=production).
//
// It builds the REAL host side in-process — a Session fed a scripted RC turn + a real HostRcRelay
// pointed at this server's own broker loopback — and returns a viewer pass + session id for the
// browser to drive. Only the worker leg is shortcut: instead of the MITM + FakeRcWorker delivering
// the worker events, we inject the SAME events straight into the Session via pushUpstream(). That
// MITM↔worker leg is separately proven end to end by rc-spine.integration.test.ts; here the point is
// to exercise relay → broker → real browser UI with production code on every leg the UI sees.

// Each seeded session runs a real serve() loop forever; a TTL bounds its lifetime so repeated seeds
// (the e2e seeds once per test) can't accumulate relays + pumps for the process lifetime. The map
// holds the controllers so the TTL (and a later seed) can abort and drop them.
const live = new Map<string, AbortController>();
const SESSION_TTL_MS = 60_000; // > any single e2e test, << a leak

/** One scripted RC turn that exercises every transcript row the UI renders (#47 + prior features).
 *  With `withPerm`, a can_use_tool control_request is injected so the UI shows a permission card —
 *  the resolved-on-reload e2e (#56) grants it, reloads, and asserts it replays as answered. */
function scenario(withPerm: boolean, withAskq = false): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "On it — I'll build, run the tests, then spawn a sub-agent to chase the flake.",
          },
        ],
      },
    },
    // A top-level Bash tool call + its Output (the tool_result the relay used to drop, #47).
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_b1",
            name: "Bash",
            input: { command: "pnpm run build", description: "build the release binary" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_b1",
            content:
              "> build\n> tsc -p . && vite build\n✓ 214 modules transformed.\n✓ built in 3.42s",
          },
        ],
      },
    },
    // A Task tool call spawns a sub-agent; the system task_started lifecycle makes it visible (#47).
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_task1",
            name: "Task",
            input: {
              description: "reproduce the flaky rc-spine test",
              prompt: "Re-run the rc-spine integration test 20× and report any flake.",
            },
          },
        ],
      },
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "tk1",
      description: "reproduce the flaky rc-spine test",
      tool_use_id: "toolu_task1",
    },
    // The sub-agent's own work nests under the Task (parent_tool_use_id ⇒ *_sub / data-sub).
    {
      type: "assistant",
      parent_tool_use_id: "toolu_task1",
      message: { content: [{ type: "text", text: "Running it 20 times to hunt the flake…" }] },
    },
    {
      type: "assistant",
      parent_tool_use_id: "toolu_task1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_s1",
            name: "Bash",
            input: { command: "for i in $(seq 20); do vitest run rc-spine; done" },
          },
        ],
      },
    },
    // Sub-agent tool_result: tagged sub (nested) AND carrying a null content block — the relay must
    // not crash on the null (codex), and the UI nests the Output under the Task (data-sub).
    {
      type: "user",
      parent_tool_use_id: "toolu_task1",
      message: {
        content: [
          null,
          {
            type: "tool_result",
            tool_use_id: "toolu_s1",
            content: [
              { type: "text", text: "run 20/20: ok — no flake reproduced (stale bus hook token)" },
              null,
            ],
          },
        ],
      },
    },
    // An error tool_result renders red.
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_b1",
            is_error: true,
            content: "error: ENOENT: no such file or directory, open 'dist/manifest.json'",
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "Build is green and the sub-agent couldn't reproduce the flake in 20 runs.",
          },
        ],
      },
    },
    { type: "result", subtype: "success", is_error: false, result: "ok" },
  ];
  if (withPerm) {
    // Inject a can_use_tool gate right after the opening line so the UI renders a permission card
    // (the relay maps it to a permission_request content frame, §17.4). Stable request_id so the e2e
    // can grant it and assert the resolved frame replays on reload.
    events.splice(1, 0, {
      type: "control_request",
      request_id: "perm-e2e-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build && pnpm run build" },
      },
    });
  }
  if (withAskq) {
    // Inject an AskUserQuestion gate (the real shape captured via --rc-trace: tool input under `input`
    // with a sibling `tool_use_id`) so the app-e2e can render the question UI + answer it (#42).
    events.splice(1, 0, {
      type: "control_request",
      request_id: "askq-e2e-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_e2e_q1",
        input: {
          questions: [
            {
              question: "Which name do you like best?",
              header: "Name pick",
              multiSelect: false,
              options: [
                { label: "Orion", description: "A bold, cosmic name." },
                { label: "Sable", description: "Sleek and distinctive." },
              ],
            },
          ],
        },
      },
    });
  }
  return events;
}

export async function POST(req: Request): Promise<Response> {
  const g = gate(req);
  if (g instanceof Response) return g; // 404 (not enabled) or 400 (non-loopback locally)
  const { origin } = g;
  const url = new URL(req.url);

  // A fresh random identity per seed so each run gets isolated bus/session channels.
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  const id = await deriveIdentity(secret);
  const pass = await formatPass(id);

  // A crypto-random session id (not Math.random) so concurrent seeds can't collide on the live-map key.
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  const sessionId = `e2e-${Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const session = new Session(sessionId, "rc box", {});
  // Forward ?backend= so the seeded host drives the SAME backend the browser will read from (the
  // BrokerClient sends it as the x-broker-backend header on its loopback calls).
  const backend = url.searchParams.get("backend") ?? undefined;
  const clientOpts: ConstructorParameters<typeof BrokerClient>[0] = {
    baseUrl: origin,
    provider: securityProvider("sealed", id),
  };
  if (backend !== undefined && backend !== "") clientOpts.backend = backend;
  // The host relay loops back to this deployment's OWN public URL; behind Vercel Deployment Protection
  // (SSO) those loopback calls would hit the 401 wall. Pass the automation-bypass secret (auto-injected
  // as an env var on the deployment) so the seed's broker round-trip reaches the routes.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) clientOpts.protectionBypass = bypass;
  const client = new BrokerClient(clientOpts);
  const relay = new HostRcRelay({ client, identityId: id.identityId, sessionId, session });

  const ac = new AbortController();
  live.set(sessionId, ac);
  const ttl = setTimeout(() => {
    ac.abort();
    live.delete(sessionId);
  }, SESSION_TTL_MS);
  if (typeof ttl.unref === "function") ttl.unref(); // don't keep the process alive for the timer

  // Announce on the bus (so the browser discovers the session), queue the scripted turn (Session
  // buffers upstream events), then run the pump. serve()'s upstream pump drains the queued events →
  // maps → publishes to the broker.
  // A FIXED git snapshot (not the deployment's real repo, which is absent on Vercel and varies
  // locally) so the app-e2e can assert a deterministic git chip (#49).
  await relay.announce("rc box", "/home/ubuntu/remote-claw", {
    branch: "main",
    sha: "abc1234",
    dirty: true,
    ahead: 2,
    behind: 0,
  });
  const withPerm = url.searchParams.get("perm") === "1"; // opt-in: inject a permission card (#56 e2e)
  const withAskq = url.searchParams.get("askq") === "1"; // opt-in: inject an AskUserQuestion (#42 e2e)
  for (const payload of scenario(withPerm, withAskq)) session.pushUpstream(payload);
  // Start the relay's pump NOW, while the request is still alive — it drains the queued scripted turn and
  // publishes the content frames to the broker. serve() is a forever-loop (it also serves LIVE inbound
  // afterwards), so we don't await it; we hand it to after() so it keeps running once the Response returns
  // (a serverless deployment FREEZES the function after the Response — without after() the queue would
  // never drain and the transcript would be empty). The catch surfaces a non-abort failure (dev-only).
  const serving = relay.serve(ac.signal).catch((e) => {
    if (!ac.signal.aborted) console.error(`[dev/seed] serve(${sessionId}) failed:`, e);
  });
  after(() => serving);
  // …and WAIT (bounded) for the scripted frames to be durably published BEFORE returning the pass. The
  // browser navigates the instant we return; on a cold preview + real Turso Cloud DB the async publish
  // can lag the viewer's read, so it would render an EMPTY transcript (the web-preview-e2e flake). This is
  // a DETERMINISTIC fix, not a timeout bump: we return only once the publish has quiesced. A non-durable
  // backend (local) reports no frameCount → its publish is synchronous-fast → this no-ops.
  await waitForSeededFrames(client, sessionId);

  return Response.json({ pass, sessionId, origin });
}

/** Poll the broker until the seeded turn's content frames are durably published — count > 0 and stable
 *  across a few polls (the drain has quiesced) — or a bounded timeout. Gates on the cursor's `durable`
 *  flag, NOT on a null count: a durable backend (sqlite/Turso) returns `frameCount: null` for a channel
 *  that doesn't exist YET (no frame published), so on a COLD path the first poll is null and we MUST keep
 *  waiting (returning there would preserve the very race we're fixing — codex). Only a NON-durable backend
 *  (local, no maxSeq) skips the wait, where the publish is synchronous-fast. NEVER throws and never fails
 *  the seed: on timeout it falls through to the browser's own assertion window. */
async function waitForSeededFrames(client: BrokerClient, sessionId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  const pollMs = 200;
  // Count unchanged across this many polls (~800ms) ⇒ the publish has settled. The window is wider than
  // the relay's inter-frame publish gap (sequential awaited posts, ~100-500ms on Turso) so it can't read
  // a mid-drain pause as "done"; a single pathologically-slow post is the residual, caught by the
  // browser's own 30s assertion window.
  const stableTarget = 4;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    let cursor: { frameCount: number | null; durable: boolean } | null = null;
    try {
      cursor = await client.frameCountCursor(sessionId);
    } catch {
      // a transient broker error mid-publish — keep polling until the deadline
    }
    if (cursor !== null) {
      if (!cursor.durable) return; // non-durable backend (local) — publish is synchronous, no wait needed
      const count = cursor.frameCount ?? 0; // durable: null/0 = channel not populated YET → keep waiting
      if (count > 0 && count === last) {
        if (++stable >= stableTarget) return;
      } else {
        stable = 0;
        last = count;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
