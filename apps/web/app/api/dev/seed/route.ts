import { deriveIdentity, formatPass, timingSafeEqual, utf8 } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { HostRcRelay, Session } from "@remote-claw/cli/rc";
import { after } from "next/server";

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

/** Only loopback origins may seed locally: the host side loops authenticated requests back to THIS
 *  server, so a spoofed Host header must not be able to point them at another origin (SSRF). */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** Constant-time check of the `x-dev-seed-token` header against the DEV_SEED_TOKEN secret. */
function tokenMatches(got: string | null): boolean {
  const want = process.env.DEV_SEED_TOKEN;
  if (!want || got === null) return false;
  const a = utf8(got);
  const b = utf8(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether THIS request may seed (and the trusted self-origin to loop the host relay back to), or a
 *  Response to return (404/400). Local dev requires loopback; a Vercel preview requires the token. */
function gate(req: Request): { origin: string } | Response {
  const onVercel = process.env.VERCEL === "1";
  const isProd = process.env.VERCEL_ENV === "production";
  const localDev = process.env.BROKER_BACKEND === "local" && !onVercel;
  const previewSeed = !isProd && tokenMatches(req.headers.get("x-dev-seed-token"));
  if (!localDev && !previewSeed) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }
  // On Vercel, loop back to the deployment's OWN canonical URL (a trusted env var, not the Host
  // header) — no SSRF surface. Locally, take the request origin but require loopback.
  if (process.env.VERCEL_URL) return { origin: `https://${process.env.VERCEL_URL}` };
  const url = new URL(req.url);
  if (!isLoopback(url.hostname)) {
    return new Response(JSON.stringify({ error: "seed is loopback-only" }), { status: 400 });
  }
  return { origin: url.origin };
}

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
  // Run the pump under after(): on a serverless deployment (the vercel backend) the function FREEZES
  // once the Response is returned, so a fire-and-forget serve() would never publish the turn — the
  // session would announce but its transcript would be empty. after() keeps the function alive to
  // drain the queue to the (durable) broker; locally it's equivalent. The catch surfaces a non-abort
  // failure (dev-only) instead of a silently-empty transcript.
  after(() =>
    relay.serve(ac.signal).catch((e) => {
      if (!ac.signal.aborted) console.error(`[dev/seed] serve(${sessionId}) failed:`, e);
    }),
  );

  return Response.json({ pass, sessionId, origin });
}
