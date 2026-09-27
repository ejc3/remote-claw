import { describe, expect, it, vi } from "vitest";
import { Session } from "../session.js";
import type { CodexClient, CodexServerRequest } from "./client.js";
import { CodexFileApprovals } from "./file-approvals.js";

const THREAD = "01993d50-6c31-7e11-9f70-3a8d9b5e7201";
const CHANGE = {
  path: "/private/scratch.txt",
  kind: { type: "update", move_path: null },
  diff: "@@ -1 +1 @@\n-before\n+after\n",
};

function started(item: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return {
    threadId: THREAD,
    turnId: "turn-1",
    startedAtMs: 1000,
    item: { type: "fileChange", id: "patch-1", status: "inProgress", changes: [CHANGE], ...item },
    ...params,
  };
}

function request(
  params: Record<string, unknown> = {},
  id: string | number = 84,
): CodexServerRequest {
  return {
    id,
    method: "item/fileChange/requestApproval",
    params: {
      threadId: THREAD,
      turnId: "turn-1",
      itemId: "patch-1",
      startedAtMs: 1001,
      reason: null,
      grantRoot: null,
      ...params,
    },
  };
}

function setup() {
  const session = new Session("file-approval-test", "test", null);
  const respondFileApproval = vi.fn<CodexClient["respondFileApproval"]>(() => true);
  const approvals = new CodexFileApprovals(session, THREAD, {
    respondFileApproval,
  } as unknown as CodexClient);
  const signal = new AbortController().signal;
  const events = (type: string) =>
    session.snapshotUpstream().filter((event) => event.eventType === type);
  const viewerId = () => {
    const id = events("control_request").at(-1)?.payload.request_id;
    if (typeof id !== "string") throw new Error("missing viewer ID");
    return id;
  };
  const respond = (id: string, behavior = "allow", extra: Record<string, unknown> = {}) =>
    approvals.respond(
      { response: { subtype: "success", request_id: id, response: { behavior, ...extra } } },
      signal,
    );
  return { session, approvals, signal, events, viewerId, respond, respondFileApproval };
}

describe("Codex fresh file approvals", () => {
  it.each([
    "allow",
    "deny",
  ])("displays the complete copied patch and sends only one native %s", (behavior) => {
    const s = setup();
    const start = structuredClone(started());
    const native = request();
    s.approvals.started(start);
    const sourceChange = start.item.changes[0];
    if (sourceChange === undefined) throw new Error("missing source change");
    sourceChange.diff = "changed mutable source";
    s.approvals.observe(native);
    const id = s.viewerId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.events("control_request")[0]?.payload.request).toEqual({
      subtype: "can_use_tool",
      tool_name: "Patch",
      input: {
        nativePatch: true,
        changes: [{ path: CHANGE.path, operation: "update", diff: CHANGE.diff }],
      },
    });
    s.respond(id, behavior, {
      updatedInput: { changes: [] },
      updatedPermissions: [{ type: "addRules" }],
      decision: "acceptForSession",
    });
    s.respond(id, behavior);
    expect(s.respondFileApproval).toHaveBeenCalledExactlyOnceWith(
      native,
      behavior === "allow" ? "accept" : "decline",
      s.signal,
    );
    expect(s.respondFileApproval.mock.calls[0]?.[0]).toBe(native);
    expect(s.events("control_cancel_request")).toHaveLength(0);
  });

  it("preserves exact add/delete/update operations, including empty added or deleted files", () => {
    const s = setup();
    s.approvals.started(
      started({
        changes: [
          { path: "/new", kind: { type: "add" }, diff: "" },
          { path: "/gone", kind: { type: "delete" }, diff: "" },
          CHANGE,
        ],
      }),
    );
    s.approvals.observe(request());
    expect(s.events("control_request")[0]?.payload.request).toMatchObject({
      input: {
        changes: [
          { path: "/new", operation: "add", diff: "" },
          { path: "/gone", operation: "delete", diff: "" },
          { path: CHANGE.path, operation: "update", diff: CHANGE.diff },
        ],
      },
    });
  });

  it.each([
    { label: "foreign thread", params: { threadId: "elsewhere" } },
    { label: "different turn", params: { turnId: "different-turn" } },
    { label: "different item", params: { itemId: "different-item" } },
    { label: "directory grant", params: { grantRoot: "/private" } },
    { label: "missing explicit null grant", params: { grantRoot: undefined } },
    {
      label: "unknown authority",
      params: { additionalPermissions: { filesystem: { write: ["/"] } } },
    },
    { label: "decision extension", params: { availableDecisions: ["acceptForSession"] } },
    { label: "invalid timestamp", params: { startedAtMs: NaN } },
    { label: "unbounded reason", params: { reason: "r".repeat(4097) } },
    { label: "invalid reason", params: { reason: {} } },
  ])("leaves $label native-owned", ({ params }) => {
    const s = setup();
    s.approvals.started(started());
    s.approvals.observe(request(params));
    expect(s.events("control_request")).toHaveLength(0);
    s.respond("84");
    expect(s.respondFileApproval).not.toHaveBeenCalled();
  });

  it.each([
    { label: "relative path", change: { ...CHANGE, path: "scratch.txt" } },
    { label: "non-Linux path", change: { ...CHANGE, path: "C:\\scratch.txt" } },
    { label: "oversized path", change: { ...CHANGE, path: `/${"a".repeat(4096)}` } },
    { label: "move", change: { ...CHANGE, kind: { type: "update", move_path: "/other" } } },
    { label: "unknown operation", change: { ...CHANGE, kind: { type: "rename" } } },
    { label: "unknown authority", change: { ...CHANGE, grantRoot: "/" } },
    {
      label: "unknown operation authority",
      change: { ...CHANGE, kind: { type: "update", permissions: "all" } },
    },
    { label: "missing diff", change: { ...CHANGE, diff: undefined } },
    { label: "empty update", change: { ...CHANGE, diff: "" } },
    { label: "bidi-control diff", change: { ...CHANGE, diff: "+safe\u202Ehidden" } },
    { label: "zero-width diff", change: { ...CHANGE, diff: "+safe\u200Bhidden" } },
    { label: "oversized multibyte diff", change: { ...CHANGE, diff: "界".repeat(12_000) } },
  ])("never truncates or authorizes $label", ({ change }) => {
    const s = setup();
    s.approvals.started(started({ changes: [change] }));
    s.approvals.observe(request());
    expect(s.events("control_request")).toHaveLength(0);
    s.approvals.started(started());
    s.approvals.observe(request({}, 85));
    expect(s.events("control_request")).toHaveLength(0);
  });

  it.each([
    { changes: [] },
    { changes: Array.from({ length: 21 }, (_, index) => ({ ...CHANGE, path: `/file-${index}` })) },
    { changes: [CHANGE, CHANGE] },
  ])("rejects empty, oversized, or duplicate-path change groups", ({ changes }) => {
    const s = setup();
    s.approvals.started(started({ changes }));
    s.approvals.observe(request());
    expect(s.events("control_request")).toHaveLength(0);
  });

  it("does not turn a request seen before its item into authority on replay", () => {
    const s = setup();
    const native = request();
    s.approvals.observe(native);
    s.approvals.started(started());
    s.approvals.observe(native);
    expect(s.events("control_request")).toHaveLength(0);
  });

  it("deduplicates identical fresh events and revokes on native resolution without naming a winner", () => {
    const s = setup();
    const native = request();
    s.approvals.started(started());
    s.approvals.started(started());
    s.approvals.observe(native);
    s.approvals.observe(native);
    const id = s.viewerId();
    expect(s.events("control_request")).toHaveLength(1);
    s.approvals.resolve({ threadId: "other", requestId: 84 });
    s.approvals.resolve({ threadId: THREAD, requestId: "84" });
    expect(s.events("control_cancel_request")).toHaveLength(0);
    s.approvals.resolve({ threadId: THREAD, requestId: 84 });
    s.approvals.resolve({ threadId: THREAD, requestId: 84 });
    s.respond(id);
    s.approvals.started(started());
    s.approvals.observe(request({}, 85));
    expect(s.events("control_cancel_request").map((e) => e.payload.request_id)).toEqual([id]);
    expect(s.events("control_request")).toHaveLength(1);
    expect(s.respondFileApproval).not.toHaveBeenCalled();
  });

  it.each([
    "completed",
    "failed",
    "declined",
  ])("revokes on native item %s and never reopens its coordinate", (status) => {
    const s = setup();
    s.approvals.started(started());
    s.approvals.observe(request());
    const id = s.viewerId();
    s.approvals.completed(started({ status }));
    s.respond(id);
    s.approvals.started(started());
    s.approvals.observe(request({}, 85));
    expect(s.events("control_request")).toHaveLength(1);
    expect(s.events("control_cancel_request")).toHaveLength(1);
    expect(s.respondFileApproval).not.toHaveBeenCalled();
  });

  it.each([
    "start",
    "request",
    "completion",
    "second-request",
  ])("drops all local authority before failing a contradictory %s", (kind) => {
    const s = setup();
    s.approvals.started(started());
    s.approvals.observe(request());
    const id = s.viewerId();
    const changed = started({ changes: [{ ...CHANGE, diff: "different proposed patch" }] });
    expect(() => {
      if (kind === "start") s.approvals.started(changed);
      else if (kind === "completion")
        s.approvals.completed({ ...changed, item: { ...changed.item, status: "completed" } });
      else if (kind === "request") s.approvals.observe(request({ grantRoot: "/" }));
      else s.approvals.observe(request({}, 85));
    }).toThrow("Codex file approval input changed");
    s.respond(id);
    expect(s.respondFileApproval).not.toHaveBeenCalled();
  });

  it("ignores invalid browser choices and consumes an ambiguous write before transport", () => {
    const s = setup();
    s.approvals.started(started());
    s.approvals.observe(request());
    const id = s.viewerId();
    s.respond("84");
    s.respond(id, "acceptForSession");
    s.respond(id, "cancel");
    expect(s.respondFileApproval).not.toHaveBeenCalled();
    s.respondFileApproval.mockImplementation(() => {
      throw Error("ambiguous write");
    });
    expect(() => s.respond(id)).toThrow("ambiguous write");
    s.respond(id);
    expect(s.respondFileApproval).toHaveBeenCalledTimes(1);
  });

  it.each(["helper", "session", "abort"])("does not submit after %s closure", (kind) => {
    const s = setup();
    s.approvals.started(started());
    s.approvals.observe(request());
    const id = s.viewerId();
    if (kind === "helper") s.approvals.close();
    else if (kind === "session") s.session.close();
    const ac = new AbortController();
    if (kind === "abort") ac.abort();
    s.approvals.respond(
      { response: { subtype: "success", request_id: id, response: { behavior: "allow" } } },
      ac.signal,
    );
    expect(s.respondFileApproval).not.toHaveBeenCalled();
  });

  it("releases pending payload capacity on completion while bounding unresolved patches", () => {
    const s = setup();
    for (let i = 0; i < 70; i++) {
      const item = started({ id: `patch-${i}` });
      s.approvals.started(item);
      s.approvals.completed({ ...item, item: { ...item.item, status: "completed" } });
    }
    for (let i = 100; i < 132; i++) s.approvals.started(started({ id: `patch-${i}` }));
    expect(() => s.approvals.started(started({ id: "patch-133" }))).toThrow("exceeded its bound");
  });
});
