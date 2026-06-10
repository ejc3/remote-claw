import { deriveIdentity, formatPass } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { HostRcRelay, Session } from "@remote-claw/cli/rc";

// DEV-ONLY seed route for the Playwright app e2e. Gated HARD to BROKER_BACKEND=local — it returns 404
// on any other backend, so it never exists in the Vercel production deploy.
//
// It builds the REAL host side in-process — a Session fed a scripted RC turn + a real HostRcRelay
// pointed at this server's own broker loopback — and returns a viewer pass + session id for the
// browser to drive. Only the worker leg is shortcut: instead of the MITM + FakeRcWorker delivering
// the worker events, we inject the SAME events straight into the Session via pushUpstream(). That
// MITM↔worker leg is separately proven end to end by rc-spine.integration.test.ts; here the point is
// to exercise relay → broker(local) → real browser UI with production code on every leg the UI sees.

// Each seeded session runs a real serve() loop forever; a TTL bounds its lifetime so repeated seeds
// (the e2e seeds once per test) can't accumulate relays + pumps for the process lifetime. The map
// holds the controllers so the TTL (and a later seed) can abort and drop them.
const live = new Map<string, AbortController>();
const SESSION_TTL_MS = 60_000; // > any single e2e test, << a leak

/** Only loopback origins may seed: the host side loops authenticated requests back to THIS server, so
 *  a spoofed Host header must not be able to point them at another origin (SSRF), even in dev. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** One scripted RC turn that exercises every transcript row the UI renders (#47 + prior features). */
function scenario(): Array<Record<string, unknown>> {
  return [
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
}

export async function POST(req: Request): Promise<Response> {
  // DEV gate: only when the in-process broker is selected AND we're not on a Vercel deploy. The real
  // production deploy uses the vercel backend and sets VERCEL=1, so this route is a 404 there even if
  // BROKER_BACKEND were somehow mis-set to local. The e2e runs `next start` locally (VERCEL unset).
  if (process.env.BROKER_BACKEND !== "local" || process.env.VERCEL === "1") {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }
  const url = new URL(req.url);
  if (!isLoopback(url.hostname)) {
    return new Response(JSON.stringify({ error: "seed is loopback-only" }), { status: 400 });
  }
  const origin = url.origin;

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
  const client = new BrokerClient(clientOpts);
  const relay = new HostRcRelay({ client, identityId: id.identityId, sessionId, session });

  const ac = new AbortController();
  live.set(sessionId, ac);
  const ttl = setTimeout(() => {
    ac.abort();
    live.delete(sessionId);
  }, SESSION_TTL_MS);
  if (typeof ttl.unref === "function") ttl.unref(); // don't keep the process alive for the timer

  // Announce on the bus (so the browser discovers the session), start the serve loop, then inject the
  // scripted turn. serve()'s upstream pump drains the queued events → maps → publishes to the broker.
  await relay.announce("rc box", "/home/ubuntu/remote-claw");
  // Surface a non-abort failure (dev-only, local machine) so a broken pump shows up in the server log
  // instead of leaving the test staring at a silently-empty transcript.
  void relay.serve(ac.signal).catch((e) => {
    if (!ac.signal.aborted) console.error(`[dev/seed] serve(${sessionId}) failed:`, e);
  });
  for (const payload of scenario()) session.pushUpstream(payload);

  return Response.json({ pass, sessionId, origin });
}
