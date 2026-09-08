import { describe, expect, it, vi } from "vitest";
import { Session } from "../session.js";
import { CodexCommandApprovals } from "./approvals.js";
import type { CodexClient, CodexServerRequest } from "./client.js";

const THREAD_ID = "01993d50-6c31-7e11-9f70-3a8d9b5e7201";

function request(
  params: Record<string, unknown> = {},
  id: string | number = "callback-1",
): CodexServerRequest {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: THREAD_ID,
      turnId: "turn-1",
      itemId: "command-1",
      kind: "command",
      environmentId: "local",
      command: "sed -n '1,10p' example.ts",
      cwd: "/example",
      reason: "Read the requested source file",
      availableDecisions: ["accept", "decline", "cancel"],
      ...params,
    },
  };
}

function setup() {
  const session = new Session("approval-test", "test", null);
  const respondCommandApproval = vi.fn<CodexClient["respondCommandApproval"]>(() => true);
  const client = { respondCommandApproval } as unknown as CodexClient;
  const approvals = new CodexCommandApprovals(session, THREAD_ID, client);
  const signal = new AbortController().signal;
  const events = (type: string) =>
    session.snapshotUpstream().filter((event) => event.eventType === type);
  const viewerIds = () =>
    events("control_request").map((event) => {
      const id = event.payload.request_id;
      if (typeof id !== "string") throw new Error("missing approval viewer ID");
      return id;
    });
  const respond = (viewerId: string, behavior = "allow", extra: Record<string, unknown> = {}) =>
    approvals.respond(
      {
        response: { subtype: "success", request_id: viewerId, response: { behavior, ...extra } },
      },
      signal,
    );
  return { session, approvals, signal, events, viewerIds, respond, respondCommandApproval };
}

describe("Codex one-command approvals", () => {
  it("projects the exact command context and sends only one decision for the observed native request", () => {
    const s = setup();
    const native = request();
    s.approvals.observe(native);
    const viewerId = s.viewerIds()[0];
    expect(viewerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(viewerId).not.toBe(native.id);
    expect(s.events("control_request")[0]?.payload).toEqual({
      type: "control_request",
      request_id: viewerId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Shell",
        input: {
          command: native.params.command,
          cwd: native.params.cwd,
          reason: `${native.params.reason}\nAllow applies to this command only. Deny rejects this command.`,
        },
      },
    });
    if (viewerId === undefined) throw new Error("missing viewer ID");
    s.respond(viewerId, "allow", {
      updatedInput: { command: "must not replace native command" },
      updatedPermissions: [{ type: "addRules", behavior: "allow" }],
      decision: "acceptForSession",
    });
    s.respond(viewerId, "deny");
    expect(s.respondCommandApproval).toHaveBeenCalledExactlyOnceWith(native, "accept", s.signal);
    expect(s.respondCommandApproval.mock.calls[0]?.[0]).toBe(native);
    // A local send does not prove which peer won; only native resolution dismisses the card.
    expect(s.events("control_cancel_request")).toEqual([]);
  });

  it.each([
    {
      decisions: ["accept", "decline", "cancel"],
      expected: "decline",
      label: "Deny rejects this command.",
    },
    { decisions: ["accept", "cancel"], expected: "cancel", label: "Deny cancels the native turn." },
  ] as const)("maps Deny only to the advertised $expected decision", ({
    decisions,
    expected,
    label,
  }) => {
    const s = setup();
    const native = request({ availableDecisions: [...decisions] });
    s.approvals.observe(native);
    const viewerId = s.viewerIds()[0];
    if (viewerId === undefined) throw new Error("missing viewer ID");
    expect(JSON.stringify(s.events("control_request"))).toContain(label);
    s.respond(viewerId, "deny");
    expect(s.respondCommandApproval).toHaveBeenCalledExactlyOnceWith(native, expected, s.signal);
  });

  it.each([
    { label: "foreign thread", params: { threadId: "another-thread" } },
    { label: "missing command kind", params: { kind: undefined } },
    { label: "non-command kind", params: { kind: "stdin" } },
    { label: "missing environment", params: { environmentId: undefined } },
    { label: "remote environment", params: { environmentId: "remote" } },
    { label: "empty turn", params: { turnId: "" } },
    { label: "oversized item", params: { itemId: "i".repeat(257) } },
    { label: "empty command", params: { command: " " } },
    { label: "non-text command", params: { command: ["echo", "hello"] } },
    { label: "oversized command", params: { command: "c".repeat(16_385) } },
    { label: "relative cwd", params: { cwd: "example" } },
    { label: "oversized cwd", params: { cwd: `/${"d".repeat(4096)}` } },
    { label: "non-text reason", params: { reason: {} } },
    { label: "oversized reason", params: { reason: "r".repeat(4097) } },
    { label: "network approval", params: { networkApprovalContext: {} } },
    { label: "additional permissions", params: { additionalPermissions: {} } },
    { label: "no advertised decisions", params: { availableDecisions: undefined } },
    { label: "no one-shot allow", params: { availableDecisions: ["acceptForSession", "cancel"] } },
    { label: "no deny", params: { availableDecisions: ["accept"] } },
  ])("leaves $label native-owned without projecting partial authority", ({ params }) => {
    const s = setup();
    s.approvals.observe(request(params));
    s.respond("callback-1");
    expect(s.events("control_request")).toEqual([]);
    expect(s.respondCommandApproval).not.toHaveBeenCalled();
  });

  it("retains bounded command context without truncation and permits absent optional context", () => {
    const s = setup();
    const native = request({
      turnId: "t".repeat(256),
      itemId: "i".repeat(256),
      command: "c".repeat(16_384),
      cwd: `/${"d".repeat(4095)}`,
      reason: "r".repeat(4096),
      networkApprovalContext: null,
      additionalPermissions: null,
    });
    s.approvals.observe(native);
    expect(s.events("control_request")[0]?.payload.request).toMatchObject({
      input: { command: native.params.command, cwd: native.params.cwd },
    });
    expect(JSON.stringify(s.events("control_request"))).toContain("r".repeat(4096));
    s.approvals.observe(request({ reason: undefined }, "no-reason"));
    expect(s.viewerIds()).toHaveLength(2);
  });

  it("keeps two callbacks sharing an item distinct, hides native IDs, and deduplicates callback replay", () => {
    const s = setup();
    const first = request({}, 7);
    const second = request({}, "7");
    s.approvals.observe(first);
    s.approvals.observe(first);
    s.approvals.observe(second);
    const ids = s.viewerIds();
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("7");
    const [one, two] = ids;
    if (one === undefined || two === undefined) throw new Error("missing viewer IDs");
    s.approvals.resolve({ threadId: THREAD_ID, requestId: 7 });
    s.respond(one);
    s.respond(two, "deny");
    expect(s.respondCommandApproval).toHaveBeenCalledExactlyOnceWith(second, "decline", s.signal);
    expect(s.events("control_cancel_request").map((event) => event.payload.request_id)).toEqual([
      one,
    ]);
  });

  it("uses native resolution, not an unrelated notification or browser guess, as final authority", () => {
    const s = setup();
    const native = request();
    s.approvals.observe(native);
    const id = s.viewerIds()[0];
    if (id === undefined) throw new Error("missing viewer ID");
    s.approvals.resolve({ threadId: "foreign", requestId: native.id });
    s.approvals.resolve({ threadId: THREAD_ID, requestId: "unrelated" });
    expect(s.events("control_cancel_request")).toEqual([]);
    s.approvals.resolve({ threadId: THREAD_ID, requestId: native.id });
    s.approvals.resolve({ threadId: THREAD_ID, requestId: native.id });
    s.respond(id);
    expect(s.respondCommandApproval).not.toHaveBeenCalled();
    expect(s.events("control_cancel_request").map((event) => event.payload.request_id)).toEqual([
      id,
    ]);
  });

  it("does not consume an approval for malformed, policy-wide, or unknown browser responses", () => {
    const s = setup();
    const native = request();
    s.approvals.observe(native);
    const id = s.viewerIds()[0];
    if (id === undefined) throw new Error("missing viewer ID");
    s.approvals.respond({ response: { subtype: "error", request_id: id } }, s.signal);
    s.approvals.respond({ response: [] }, s.signal);
    s.respond(id, "acceptForSession");
    s.respond("not-an-observed-viewer-id");
    expect(s.respondCommandApproval).not.toHaveBeenCalled();
    s.respond(id);
    expect(s.respondCommandApproval).toHaveBeenCalledExactlyOnceWith(native, "accept", s.signal);
  });

  it.each(["closed", "aborted"])("does not respond after the projection is %s", (state) => {
    const s = setup();
    s.approvals.observe(request());
    const id = s.viewerIds()[0];
    if (id === undefined) throw new Error("missing viewer ID");
    const ac = new AbortController();
    if (state === "closed") s.session.close();
    else ac.abort();
    s.approvals.respond(
      { response: { subtype: "success", request_id: id, response: { behavior: "allow" } } },
      ac.signal,
    );
    expect(s.respondCommandApproval).not.toHaveBeenCalled();
  });

  it("does not project questions, file/network controls, or commands after closure", () => {
    const s = setup();
    for (const method of [
      "item/tool/requestUserInput",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]) {
      s.approvals.observe({ ...request(), method });
    }
    s.session.close();
    s.approvals.observe(request());
    expect(s.events("control_request")).toEqual([]);
    expect(s.respondCommandApproval).not.toHaveBeenCalled();
  });

  it("consumes an ambiguous write before transport and never retries it", () => {
    const s = setup();
    s.approvals.observe(request());
    const id = s.viewerIds()[0];
    if (id === undefined) throw new Error("missing viewer ID");
    s.respondCommandApproval.mockImplementation(() => {
      throw new Error("unknown write outcome");
    });
    expect(() => s.respond(id)).toThrow("unknown write outcome");
    expect(() => s.respond(id)).not.toThrow();
    expect(s.respondCommandApproval).toHaveBeenCalledTimes(1);
    expect(s.events("control_cancel_request")).toEqual([]);
  });
});
