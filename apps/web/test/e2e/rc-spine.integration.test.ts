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
import { formatPass, type Identity } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { ensureCerts, HostRcRelay, MitmProxy, RelayCore } from "@remote-claw/cli/rc";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { parsePermissionResolved, parseQuestions } from "../../app/lib/transcript";
import { type Announce, type Message, Viewer } from "../../app/lib/viewer";
import { displayedPermissionMode } from "../../app/page";
import { uniqueIdentity } from "../helpers";
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
    const id = await uniqueIdentity();
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
    const id = await uniqueIdentity();
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
    const id = await uniqueIdentity();
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
    const id = await uniqueIdentity();
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
    const id = await uniqueIdentity();
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
    const id = await uniqueIdentity();
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

  it("CONTROL VERBS: interrupt / set_model / set_mode reach the worker (end is local-only) + slash-command", async () => {
    const id = await uniqueIdentity();
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

    // `end` drives NO worker control_request (claude's REPL bridge rejects end_session — PR #92), so
    // only THREE verbs reach the worker: interrupt / set_model / set_permission_mode.
    await waitFor(() => verbs.length >= 3 && userInputs.includes("/compact"));
    const subs = verbs.map((v) => v.subtype);
    expect(subs).toContain("interrupt");
    expect(verbs.find((v) => v.subtype === "set_model")?.req.model).toBe("claude-opus-4-8");
    expect(verbs.find((v) => v.subtype === "set_permission_mode")?.req.mode).toBe("plan");
    expect(subs).not.toContain("end_session"); // `end` is local-only (clears gates); claude has no end_session verb
    expect(userInputs).toContain("/compact"); // slash command delivered as user input
  }, 40_000);

  it("PERMISSION MODE: a change from one viewer converges on another viewer's chip", async () => {
    const id = await uniqueIdentity();
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");
    const verbs: Array<{ subtype: string; req: Record<string, unknown> }> = [];
    worker.onControlRequest((subtype, req) => verbs.push({ subtype, req }));
    worker.start(sid);

    const driver = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const observer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const seen: Announce[] = [];
    void (async () => {
      for await (const a of observer.announces(ac.signal)) if (a.sessionId === sid) seen.push(a);
    })().catch(() => {});
    await waitFor(() => seen.length > 0, 15_000);

    await driver.setMode(sid, "plan");

    await waitFor(() => seen.some((a) => a.mode === "plan"), 15_000);
    await waitFor(() => verbs.some((v) => v.subtype === "set_permission_mode"), 15_000);
    const latestMode = [...seen].reverse().find((a) => a.mode !== undefined)?.mode;
    expect(latestMode).toBe("plan");
    expect(displayedPermissionMode(latestMode, null)).toBe("plan");
    expect(verbs.find((v) => v.subtype === "set_permission_mode")?.req.mode).toBe("plan");
  }, 40_000);

  it("PRESENCE + PERMISSION_RESOLVED: announce carries phase/status/needs; granting a permission logs permission_resolved (unordered, replayed on catch_up)", async () => {
    // Uses a fresh uniqueIdentity() so this test doesn't share broker state with the PERMISSION test
    // or any other test (every test gets its own random identity). Two things are proven here with one
    // worker lifecycle:
    //   (A) The session_announce body carries `status`, `phase`, and `needs`. The `needs` flag
    //       transitions true→false across the permission grant — the `phase` field is validated as
    //       structurally present; catching the transient "busy"→"thinking" window is not attempted here
    //       because the FakeRcWorker's busy→idle cycle is near-instant (no model latency). A separate
    //       unit test covers phaseFor() directly; here we prove the wire fields exist and that
    //       `needs` is driven by the open/closed state of the permission gate.
    //   (B) Granting an inbound permission emits a LOGGED `permission_resolved` unordered frame (not
    //       just the control_response sent to the worker) so a fresh viewer's catch_up replays it.
    const id = await uniqueIdentity();
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");

    // ── A: collect raw announce bodies straight off the bus. (Viewer.announces() ALSO surfaces
    //    status/phase/needs now — see the VIEWER PRESENCE test below — but here we decode the bus
    //    directly via a same-identity BrokerClient so this host-side proof is independent of the viewer
    //    parse: it asserts the wire actually carries the fields, not just that the viewer copies them.)
    const rawAnnounces: Array<{
      status: string;
      phase: string;
      needs: boolean;
      sentAt: number;
    }> = [];
    const busClient = new BrokerClient({
      baseUrl: "http://broker",
      provider: securityProvider("sealed", id),
      fetchFn: brokerFetch,
    });
    // Mirror the retry loop from Viewer.announces(): the bus workflow might not exist yet on the
    // first subscribe attempt (the relay.announce() inside onSession is fire-and-forget; it may not
    // have completed by the time we start streaming). Re-subscribing every 150 ms matches the
    // viewer's own resume-or-retry logic, and the startIndex:-64 replay ensures we don't miss an
    // announce that posted between retries.
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          for await (const frame of busClient.streamFrames({
            startIndex: -64,
            signal: ac.signal,
          })) {
            if (frame.recordKind !== "session_announce") continue;
            let body: Record<string, unknown>;
            try {
              body = JSON.parse(new TextDecoder().decode(await busClient.openFrame(frame)));
            } catch {
              continue;
            }
            if (body.session_id !== sid) continue; // filter to this session only
            rawAnnounces.push({
              status: typeof body.status === "string" ? body.status : "",
              phase: typeof body.phase === "string" ? body.phase : "",
              needs: body.needs === true,
              sentAt: typeof body.sent_at === "number" ? body.sent_at : 0,
            });
          }
        } catch {
          // transient error (bus not yet created / SSE reset) — retry shortly
        }
        if (ac.signal.aborted) break;
        await sleep(150);
      }
    })().catch(() => {});

    // Wait for the initial announce (the one relay.announce() fires on register) to arrive in our
    // bus stream. This ensures the busClient is live before we kick off the turn.
    await waitFor(() => rawAnnounces.length > 0, 15_000);
    // The initial announce is posted before any turn, so the worker is idle and no gate is open.
    const initAnnounce = rawAnnounces[0];
    // Every announce must carry all three presence fields (structural check):
    expect(typeof initAnnounce?.status).toBe("string"); // raw worker_status string
    expect(initAnnounce?.phase === "idle" || initAnnounce?.phase === "thinking").toBe(true);
    expect(typeof initAnnounce?.needs).toBe("boolean");

    // ── A (continued): start the worker with a can_use_tool control_request. The open gate drives
    //    `needs=true` in the presence announce after #pumpUpstream processes the event — this is
    //    reliably observable (unlike the transient busy→thinking window) because #openPerms persists
    //    until the permission answer arrives.
    let granted = false;
    worker.onControlResponse(() => {
      granted = true;
    });
    worker.start(sid, () => [
      {
        type: "control_request",
        request_id: "perm-presence-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_input: { command: "echo presence" },
        },
      },
    ]);

    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const got: Message[] = [];
    tailInto(viewer, sid, got, ac.signal);

    // Trigger the turn: relay processes the control_request, opens the gate (#openPerms), and
    // re-announces with needs=true (key changed → re-announce fires promptly, not waiting for the
    // 10 s keepalive floor).
    await viewer.sendPrompt(sid, "use a tool");

    // Wait for the permission_request content frame (proves the relay processed the upstream event).
    await waitFor(() => got.some((m) => m.kind === "permission_request"), 20_000);
    const reqFrame = got.find((m) => m.kind === "permission_request");
    const requestId = JSON.parse(reqFrame?.text ?? "{}").request_id as string;
    expect(requestId).toBe("perm-presence-1");

    // After #pumpUpstream logs the permission_request and calls #maybeAnnounce, needs flips true.
    // The keepalive-OR-change logic fires immediately on a key change, so this isn't a 10 s wait.
    await waitFor(() => rawAnnounces.some((a) => a.needs === true), 15_000);
    // Every announce with needs=true must carry the structural fields (belt-and-suspenders).
    for (const a of rawAnnounces.filter((r) => r.needs)) {
      expect(a.phase === "idle" || a.phase === "thinking").toBe(true);
      expect(typeof a.status).toBe("string");
    }

    // ── B: grant the permission — relay logs permission_resolved and clears the open gate.
    await viewer.grantPermission(sid, requestId, "allow");
    await waitFor(() => granted, 15_000);
    expect(granted).toBe(true);

    // The permission_resolved unordered frame must appear in the live transcript.
    await waitFor(() => got.some((m) => m.kind === "permission_resolved"), 15_000);
    const resolvedFrame = got.find((m) => m.kind === "permission_resolved");
    const resolvedBody = JSON.parse(resolvedFrame?.text ?? "{}");
    expect(resolvedBody.request_id).toBe("perm-presence-1");
    expect(resolvedBody.behavior).toBe("allow");
    expect(resolvedFrame?.seq).toBeNull(); // unordered: a content gap must not stall it

    // After the grant the relay deletes from #openPerms and calls #maybeAnnounce: needs must drop.
    // Wait for the GRANT's needs=false announce specifically — one at or after the first needs=true,
    // NOT the session's INITIAL needs=false. The grant announce now lands slightly later (the durable
    // permission_resolved log is written before the worker side effect + re-announce), so under
    // full-suite load we must WAIT for it rather than race the assertion against it.
    await waitFor(() => {
      const nt = rawAnnounces.filter((a) => a.needs === true);
      const nf = rawAnnounces.filter((a) => a.needs === false && a.sentAt > 0);
      return nt.length > 0 && nf.some((a) => a.sentAt >= (nt[0]?.sentAt ?? 0));
    }, 15_000);
    // We must have seen BOTH a needs=true announce and a later needs=false one for this session —
    // i.e., the full true→false transition happened on the bus.
    const needsTrue = rawAnnounces.filter((a) => a.needs === true);
    const needsFalse = rawAnnounces.filter((a) => a.needs === false && a.sentAt > 0);
    expect(needsTrue.length).toBeGreaterThanOrEqual(1);
    expect(needsFalse.length).toBeGreaterThanOrEqual(1);
    // A needs=false announce must come no earlier than the first needs=true one.
    expect(needsFalse[needsFalse.length - 1]?.sentAt ?? 0).toBeGreaterThanOrEqual(
      needsTrue[0]?.sentAt ?? 0,
    );

    // ── B (continued): fresh viewer's catch_up must replay permission_resolved. It is unordered but
    //    still replay-logged by the non-durable relay, so #replay() sends it again with the same msg_id.
    const late = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const lateMsgs: Message[] = [];
    tailInto(late, sid, lateMsgs, ac.signal);
    await late.requestHistory(sid, 0);
    await waitFor(() => lateMsgs.some((m) => m.kind === "permission_resolved"), 20_000);
    const replayedResolved = lateMsgs.find((m) => m.kind === "permission_resolved");
    expect(JSON.parse(replayedResolved?.text ?? "{}")).toMatchObject({
      request_id: "perm-presence-1",
      behavior: "allow",
    });
  }, 50_000);

  it("MULTI-CLIENT: two devices drive turns on one RC session; both see the shared timeline", async () => {
    const id = await uniqueIdentity();
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

  it("VIEWER PRESENCE + RESOLVED-ON-RELOAD: announces() surfaces phase/needs; a fresh viewer's catch_up renders the permission resolved", async () => {
    // The viewer-side complement to the host-side PRESENCE test. Proves the two things the web UI
    // actually depends on, through the REAL viewer APIs (not a hand-rolled bus decode):
    //   (A) Viewer.announces() now surfaces {status, phase, needs}, and `needs` transitions
    //       false→true→false across a permission gate opening and being granted.
    //   (B) A cold second device (no local PermissionRow state) replays history and folds the LOGGED
    //       permission_resolved into the SAME {requestId→behavior} map page.tsx uses — so it renders
    //       the request resolved (allow), never re-prompting with live buttons (#56/#57).
    const id = await uniqueIdentity();
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");

    const seen: Announce[] = [];
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    void (async () => {
      for await (const a of viewer.announces(ac.signal)) if (a.sessionId === sid) seen.push(a);
    })().catch(() => {});
    // The pre-turn announce: idle worker, no open gate → the viewer reads it as not-needing-input.
    await waitFor(() => seen.length > 0, 15_000);
    const first = seen[0];
    expect(typeof first?.status).toBe("string");
    expect(first?.phase === "idle" || first?.phase === "thinking").toBe(true);
    expect(first?.needs).toBe(false);

    // Open a can_use_tool gate; the relay re-announces needs=true and announces() surfaces it.
    let granted = false;
    worker.onControlResponse(() => {
      granted = true;
    });
    worker.start(sid, () => [
      {
        type: "control_request",
        request_id: "perm-viewer-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
        },
      },
    ]);

    const got: Message[] = [];
    tailInto(viewer, sid, got, ac.signal);
    await viewer.sendPrompt(sid, "use a tool");
    await waitFor(() => got.some((m) => m.kind === "permission_request"), 20_000);
    await waitFor(() => seen.some((a) => a.needs === true), 15_000);

    // Grant it — the host logs permission_resolved and re-announces needs=false.
    await viewer.grantPermission(sid, "perm-viewer-1", "allow");
    await waitFor(() => granted, 15_000);
    await waitFor(
      () => seen.some((a) => a.needs === false && a.sentAt > (first?.sentAt ?? 0)),
      15_000,
    );

    // (B) Cold reload: a fresh viewer replays history and folds permission_resolved exactly as the UI.
    const late = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const lateMsgs: Message[] = [];
    tailInto(late, sid, lateMsgs, ac.signal);
    await late.requestHistory(sid, 0);
    await waitFor(() => lateMsgs.some((m) => m.kind === "permission_request"), 20_000);
    await waitFor(() => lateMsgs.some((m) => m.kind === "permission_resolved"), 20_000);

    const resolvedMap = new Map<string, "allow" | "deny">();
    for (const m of lateMsgs) {
      if (m.kind !== "permission_resolved") continue;
      const r = parsePermissionResolved(m.text);
      if (r.requestId !== "") resolvedMap.set(r.requestId, r.behavior);
    }
    // page.tsx: effective = confirmed ?? decision → "allow" with no local decision → renders resolved.
    expect(resolvedMap.get("perm-viewer-1")).toBe("allow");
  }, 50_000);

  it("ASKUSERQUESTION: a can_use_tool with questions round-trips an answer (updatedInput.answers + toolUseID)", async () => {
    // The full #42 spine, against the SHAPES captured live via --rc-trace: the worker surfaces an
    // AskUserQuestion can_use_tool (`input.questions` + `tool_use_id`); the viewer renders the
    // questions (parseQuestions) and answers; the relay sends a control_response whose response carries
    // {behavior:"allow", toolUseID, updatedInput:{answers:{question→label}}}.
    const id = await uniqueIdentity();
    const ac = new AbortController();
    cleanup.push(() => ac.abort());
    const { worker } = await startRc(id, ac);
    const sid = await worker.register("rc box");

    let answer: Record<string, unknown> | undefined;
    worker.onControlResponse((_rid, _b, response) => {
      answer = response;
    });
    // Real shape: the tool input is under `input` (not `tool_input`), with a sibling `tool_use_id`.
    worker.start(sid, () => [
      {
        type: "control_request",
        request_id: "askq-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_q1",
          input: {
            questions: [
              {
                question: "Which name?",
                header: "Name pick",
                multiSelect: false,
                options: [
                  { label: "Orion", description: "cosmic" },
                  { label: "Sable", description: "sleek" },
                ],
              },
            ],
          },
        },
      },
    ]);

    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const got: Message[] = [];
    tailInto(viewer, sid, got, ac.signal);
    await viewer.sendPrompt(sid, "pick a name");

    // The relay surfaced the questions + tool_use_id on the permission_request (real `input` shape).
    await waitFor(() => got.some((m) => m.kind === "permission_request"), 20_000);
    const reqFrame = got.find((m) => m.kind === "permission_request");
    const parsed = JSON.parse(reqFrame?.text ?? "{}");
    expect(parsed.tool_use_id).toBe("toolu_q1");
    const questions = parseQuestions(parsed.tool_input);
    expect(questions[0]?.options.map((o) => o.label)).toEqual(["Orion", "Sable"]);

    // The viewer answers with the chosen label, keyed by question text, + the request's tool_use_id.
    await viewer.grantPermission(sid, "askq-1", "allow", {
      answers: { "Which name?": "Orion" },
      toolUseId: "toolu_q1",
    });

    // The worker receives the exact control_response shape claude expects.
    await waitFor(() => answer !== undefined, 15_000);
    expect(answer?.behavior).toBe("allow");
    expect(answer?.toolUseID).toBe("toolu_q1");
    expect((answer?.updatedInput as { answers?: unknown })?.answers).toEqual({
      "Which name?": "Orion",
    });
  }, 50_000);
});
