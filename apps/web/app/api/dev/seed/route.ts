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

// Keep each seeded session's serve() loop alive across requests (and un-GC'd) for the test's lifetime.
const live = new Map<string, AbortController>();

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
  if (process.env.BROKER_BACKEND !== "local") {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }
  const origin = new URL(req.url).origin;

  // A fresh random identity per seed so parallel test runs get isolated bus/session channels.
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  const id = await deriveIdentity(secret);
  const pass = await formatPass(id);

  const sessionId = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  const session = new Session(sessionId, "rc box", {});
  const client = new BrokerClient({ baseUrl: origin, provider: securityProvider("sealed", id) });
  const relay = new HostRcRelay({ client, identityId: id.identityId, sessionId, session });

  const ac = new AbortController();
  live.set(sessionId, ac);

  // Announce on the bus (so the browser discovers the session), start the serve loop, then inject the
  // scripted turn. serve()'s upstream pump drains the queued events → maps → publishes to the broker.
  await relay.announce("rc box", "/home/ubuntu/remote-claw");
  void relay.serve(ac.signal).catch(() => {});
  for (const payload of scenario()) session.pushUpstream(payload);

  return Response.json({ pass, sessionId, origin });
}
