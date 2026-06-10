// RC-SPINE e2e — the WHOLE spine with ONLY claude faked, and the fake speaks the REAL
// `--remote-control` worker protocol through the REAL MITM:
//
//   FakeRcWorker --(HTTPS_PROXY → CONNECT → our leaf)--> MitmProxy --serves /v1/code/sessions*-->
//   RelayCore/Session  <->  HostRcRelay  <->  REAL broker routes on the REAL Workflow runtime  <->
//   web Viewer (phone/laptop)
//
// The worker register→triggers→bridge→worker→SSE→delivery-ack→events→heartbeat sequence matches the
// captured real-claude flow (phase0/mitm/captures, §17.2). So every leg is production code except the
// model itself; the real binary is additionally proven by real-rc.prove.test.ts. Covers: a turn
// round-trip, session discovery on the bus, history replay (catch_up), and multi-client.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, formatPass, type Identity } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { ensureCerts, HostRcRelay, MitmProxy, RelayCore } from "@remote-claw/cli/rc";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { type Message, Viewer } from "../../app/lib/viewer";
import { FakeRcWorker } from "./fake-rc-worker";
import { brokerFetch } from "./harness";

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const RUN = haveOpenssl();

const cleanup: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanup) await c();
  await teardownWorkflowTests();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await sleep(50);
  if (!pred()) throw new Error("timed out waiting for a condition");
}

function hostClient(id: Identity): BrokerClient {
  return new BrokerClient({
    baseUrl: "http://broker",
    provider: securityProvider("sealed", id),
    fetchFn: brokerFetch,
  });
}

function tailInto(viewer: Viewer, sid: string, sink: Message[], signal: AbortSignal): void {
  void (async () => {
    for await (const m of viewer.transcript(sid, signal)) sink.push(m);
  })().catch(() => {});
}

/** Stand up the MITM for one identity: each RC session the worker registers gets a HostRcRelay that
 *  announces on the bus and serves it to the broker. Returns a worker bound to the proxy. */
async function startRc(id: Identity, ac: AbortController): Promise<{ worker: FakeRcWorker }> {
  const dir = mkdtempSync(join(tmpdir(), "rc-spine-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const certs = ensureCerts(dir);
  const ca = readFileSync(certs.caPem);
  const core = new RelayCore();
  const proxy = new MitmProxy({
    port: 0,
    leafCert: certs.leafPem,
    leafKey: certs.leafKey,
    core,
    onSession: (s) => {
      const relay = new HostRcRelay({
        client: hostClient(id),
        identityId: id.identityId,
        sessionId: s.id,
        session: s,
      });
      void relay.announce("rc box").catch(() => {});
      void relay.serve(ac.signal).catch(() => {});
    },
  });
  await proxy.listen();
  const worker = new FakeRcWorker(proxy.port, ca);
  cleanup.push(() => worker.stop());
  cleanup.push(() => proxy.close());
  return { worker };
}

describe.skipIf(!RUN)("rc-spine e2e (real MITM + real RC worker protocol + real broker)", () => {
  it("drives a turn through the FULL path and the viewer discovers the session on the bus", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(60));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);

    // The worker registers (real RC handshake through the MITM) → HostRcRelay announces on the bus.
    const sid = await worker.register("rc box");
    worker.start(sid);

    // The viewer discovers the session on the bus (presence), exactly like the phone/web app.
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const announces: string[] = [];
    void (async () => {
      for await (const a of viewer.announces(ac.signal)) announces.push(a.sessionId);
    })().catch(() => {});
    await waitFor(() => announces.includes(sid));

    // Drive a turn: viewer prompt → broker → relay → MITM SSE → worker → upstream → relay → broker.
    const got: Message[] = [];
    tailInto(viewer, sid, got, ac.signal);
    await viewer.sendPrompt(sid, "hello rc");
    await waitFor(() => got.some((m) => m.kind === "result"));

    expect(got.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(["hello rc"]);
    expect(got.filter((m) => m.kind === "assistant").map((m) => m.text)).toEqual([
      "echo: hello rc",
    ]);
    expect(got.filter((m) => m.kind === "result")).toHaveLength(1);
    expect(got.filter((m) => m.seq !== null).map((m) => m.seq)).toEqual([0, 1, 2]);
  }, 40_000);

  it("CATCH_UP: a late device replays the transcript from the live RC relay", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(61));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");
    worker.start(sid);

    const driver = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const driverMsgs: Message[] = [];
    tailInto(driver, sid, driverMsgs, ac.signal);
    await driver.sendPrompt(sid, "remember me");
    await waitFor(() => driverMsgs.some((m) => m.kind === "result"));

    const late = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const lateMsgs: Message[] = [];
    tailInto(late, sid, lateMsgs, ac.signal);
    await late.requestHistory(sid, 0);
    await waitFor(() => lateMsgs.some((m) => m.kind === "result"));

    expect(lateMsgs.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(["remember me"]);
    expect(lateMsgs.filter((m) => m.kind === "assistant").map((m) => m.text)).toEqual([
      "echo: remember me",
    ]);
    expect(lateMsgs.filter((m) => m.seq !== null).map((m) => m.seq)).toEqual([0, 1, 2]);
  }, 40_000);

  it("SUB-AGENTS: a Task tool_use + sub-agent output relay through as tool_use + assistant_sub frames", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(63));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");
    // The worker answers with a real sub-agent turn: a Task tool_use (spawn), the sub-agent's own
    // assistant reply (parent_tool_use_id set), then the parent assistant text + result.
    worker.start(sid, () => [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "delegating to a sub-agent" },
            {
              type: "tool_use",
              id: "toolu_task1",
              name: "Task",
              input: { description: "research the thing" },
            },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_task1",
        message: {
          content: [
            { type: "thinking", thinking: "sub-agent reasoning" },
            { type: "text", text: "sub-agent here: found it" },
          ],
        },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "all done" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ]);

    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const got: Message[] = [];
    tailInto(viewer, sid, got, ac.signal);
    await viewer.sendPrompt(sid, "do a big task");
    await waitFor(() => got.some((m) => m.kind === "result"));

    // Parent text, the Task spawn (tool_use), the SUB-AGENT's thinking (assistant_thinking_sub) +
    // reply (assistant_sub), then the parent's final text — in order, on one gap-free timeline.
    const kinds = got.filter((m) => m.seq !== null).map((m) => m.kind);
    expect(kinds).toEqual([
      "user",
      "assistant",
      "tool_use",
      "assistant_thinking_sub",
      "assistant_sub",
      "assistant",
      "result",
    ]);
    const tool = got.find((m) => m.kind === "tool_use");
    expect(JSON.parse(tool?.text ?? "{}").name).toBe("Task"); // the sub-agent spawn is visible
    expect(got.find((m) => m.kind === "assistant_thinking_sub")?.text).toBe("sub-agent reasoning");
    expect(got.find((m) => m.kind === "assistant_sub")?.text).toBe("sub-agent here: found it");
    expect(got.filter((m) => m.seq !== null).map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  }, 40_000);

  it("TOOL_RESULT + TASK: a tool's output (user/tool_result) + a sub-agent Task lifecycle (system) relay; noise is dropped", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(64));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");
    worker.start(sid, () => [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_bash1", name: "Bash", input: { command: "echo hi" } },
          ],
        },
      },
      // The worker posts the tool OUTPUT as a user-role tool_result; the text block is the prompt
      // echo and must NOT be re-relayed (the inbound pump already emitted the user prompt).
      {
        type: "user",
        message: {
          content: [
            { type: "text", text: "prompt echo — must be dropped" },
            { type: "tool_result", tool_use_id: "toolu_bash1", content: "hi\n" },
          ],
        },
      },
      {
        type: "system",
        subtype: "task_started",
        task_id: "tk1",
        description: "research the thing",
        tool_use_id: "toolu_task1",
      },
      // A SUB-AGENT's tool output: a user event tagged with the spawning Task's parent_tool_use_id.
      // Its content array holds a `null` (untrusted model JSON) and a tool_result whose own content
      // array also holds a `null` — the relay must tag the frame `sub` AND not crash on either null
      // (codex: an unguarded `.type` deref here would kill #pumpUpstream and stall all later output).
      {
        type: "user",
        parent_tool_use_id: "toolu_task1",
        message: {
          content: [
            null,
            {
              type: "tool_result",
              tool_use_id: "toolu_sub1",
              content: [{ type: "text", text: "sub out" }, null],
            },
          ],
        },
      },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }, // noisy — must be dropped
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ]);

    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const got: Message[] = [];
    tailInto(viewer, sid, got, ac.signal);
    await viewer.sendPrompt(sid, "run it");
    await waitFor(() => got.some((m) => m.kind === "result"));

    const kinds = got.filter((m) => m.seq !== null).map((m) => m.kind);
    // inbound user echo, the Bash call, its Output, the Task lifecycle, the sub-agent's Output, the
    // reply, result. The worker's user-text echo and the thinking_tokens are dropped (no double
    // prompt, no token spam); the null content blocks must not abort the relay.
    expect(kinds).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "task",
      "tool_result",
      "assistant",
      "result",
    ]);
    const toolResults = got.filter((m) => m.kind === "tool_result").map((m) => JSON.parse(m.text));
    expect(toolResults[0]).toMatchObject({
      tool_use_id: "toolu_bash1",
      is_error: false,
      output: "hi\n",
      sub: false,
    });
    // The sub-agent's tool_result is tagged sub and survives the null content element.
    expect(toolResults[1]).toMatchObject({
      tool_use_id: "toolu_sub1",
      output: "sub out",
      sub: true,
    });
    // The Task lifecycle carries the spawning tool_use_id so the UI can correlate it to the Task row.
    expect(JSON.parse(got.find((m) => m.kind === "task")?.text ?? "{}")).toMatchObject({
      subtype: "task_started",
      description: "research the thing",
      tool_use_id: "toolu_task1",
    });
  }, 40_000);

  it("THINKING: an extended-thinking block relays through as an assistant_thinking frame", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(66));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");
    // The worker answers with a thinking block, then the visible reply, then result.
    worker.start(sid, () => [
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me reason about this step by step" },
            { type: "text", text: "the answer is 42" },
          ],
        },
      },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ]);

    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const got: Message[] = [];
    tailInto(viewer, sid, got, ac.signal);
    await viewer.sendPrompt(sid, "think hard");
    await waitFor(() => got.some((m) => m.kind === "result"));

    // user → thinking → assistant → result, one gap-free timeline.
    expect(got.filter((m) => m.seq !== null).map((m) => m.kind)).toEqual([
      "user",
      "assistant_thinking",
      "assistant",
      "result",
    ]);
    expect(got.find((m) => m.kind === "assistant_thinking")?.text).toBe(
      "let me reason about this step by step",
    );
    expect(got.find((m) => m.kind === "assistant")?.text).toBe("the answer is 42");
  }, 40_000);

  it("PERMISSION: a worker can_use_tool surfaces to the viewer, which grants it back to the worker", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(64));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");

    // The worker asks to run a tool (control_request can_use_tool) instead of auto-executing, then —
    // once the grant arrives downstream — finishes the turn. The grant detection is wired below.
    let granted = false;
    worker.onControlResponse(() => {
      granted = true;
    });
    worker.start(sid, () => [
      {
        type: "control_request",
        request_id: "perm-1",
        request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "echo hi" } },
      },
    ]);

    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const got: Message[] = [];
    tailInto(viewer, sid, got, ac.signal);
    await viewer.sendPrompt(sid, "run a tool");

    // The viewer receives the permission_request frame…
    await waitFor(() => got.some((m) => m.kind === "permission_request"));
    const reqFrame = got.find((m) => m.kind === "permission_request");
    const requestId = JSON.parse(reqFrame?.text ?? "{}").request_id;
    expect(requestId).toBe("perm-1");
    expect(JSON.parse(reqFrame?.text ?? "{}").tool_name).toBe("Bash");

    // …and grants it — the worker receives the control_response downstream.
    await viewer.grantPermission(sid, requestId, "allow");
    await waitFor(() => granted);
    expect(granted).toBe(true);
  }, 40_000);

  it("CONTROL VERBS: interrupt / set_model / set_mode / end + slash-command reach the worker", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(65));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");
    const verbs: Array<{ subtype: string; req: Record<string, unknown> }> = [];
    const userInputs: string[] = [];
    worker.onControlRequest((subtype, req) => verbs.push({ subtype, req }));
    // A slash command is delivered as user input — capture what the worker receives.
    worker.start(sid, (text) => {
      userInputs.push(text);
      return [{ type: "result", subtype: "success", result: "ok" }];
    });

    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    // The first control frame creates the session run; the relay's inbound pump picks them all up.
    await viewer.interrupt(sid);
    await viewer.setModel(sid, "claude-opus-4-8");
    await viewer.setMode(sid, "plan");
    await viewer.command(sid, "/compact");
    await viewer.endSession(sid);

    await waitFor(() => verbs.length >= 4 && userInputs.includes("/compact"));
    const subs = verbs.map((v) => v.subtype);
    expect(subs).toContain("interrupt");
    expect(verbs.find((v) => v.subtype === "set_model")?.req.model).toBe("claude-opus-4-8");
    expect(verbs.find((v) => v.subtype === "set_permission_mode")?.req.mode).toBe("plan");
    expect(subs).toContain("end_session"); // `end` maps to end_session
    expect(userInputs).toContain("/compact"); // slash command delivered as user input
  }, 40_000);

  it("MULTI-CLIENT: two devices drive turns on one RC session; both see the shared timeline", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(62));
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");
    worker.start(sid);

    const phone = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const laptop = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const phoneMsgs: Message[] = [];
    const laptopMsgs: Message[] = [];
    tailInto(phone, sid, phoneMsgs, ac.signal);
    tailInto(laptop, sid, laptopMsgs, ac.signal);

    await phone.sendPrompt(sid, "from phone");
    await waitFor(() => phoneMsgs.some((m) => m.kind === "result"));
    await laptop.sendPrompt(sid, "from laptop");
    const twoTurns = (ms: Message[]) => ms.filter((m) => m.kind === "result").length >= 2;
    await waitFor(() => twoTurns(phoneMsgs) && twoTurns(laptopMsgs));

    for (const msgs of [phoneMsgs, laptopMsgs]) {
      expect(msgs.filter((m) => m.seq !== null).map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(msgs.filter((m) => m.kind === "user").map((m) => m.text)).toEqual([
        "from phone",
        "from laptop",
      ]);
      expect(msgs.filter((m) => m.kind === "assistant").map((m) => m.text)).toEqual([
        "echo: from phone",
        "echo: from laptop",
      ]);
    }
  }, 40_000);
});
