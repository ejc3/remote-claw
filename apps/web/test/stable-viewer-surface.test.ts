import { formatPass } from "@remote-claw/clawsec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Announce, type Message, parseCapabilities, Viewer } from "../app/lib/viewer.js";
import {
  Bubble,
  isStableClaudeSurface,
  optimisticMessage,
  reconcileAccepted,
  Transcript,
} from "../app/page.js";
import { uniqueIdentity } from "./helpers.js";

const noGrant = async () => undefined;
const noAnswers = new Map<string, Record<string, string | string[]>>();

function renderBubble(
  message: Message,
  opts: {
    canGrant?: boolean;
    permissionsLocal?: boolean;
    permissionAgent?: "Claude" | "OpenCode" | "Codex";
    hostConnected?: boolean;
  } = {},
  resolved = new Map<string, "allow" | "deny">(),
): string {
  return renderToStaticMarkup(
    createElement(Bubble, {
      message,
      onGrant: noGrant,
      canGrant: opts.canGrant ?? true,
      permissionsLocal: opts.permissionsLocal ?? false,
      permissionAgent: opts.permissionAgent ?? "Claude",
      hostConnected: opts.hostConnected ?? true,
      resolved,
      resolvedAnswers: noAnswers,
    }),
  );
}

describe("stable viewer surface", () => {
  it("renders current tmux permission mode, not the local launch snapshot, after mode changes", async () => {
    const viewer = await Viewer.fromPass(
      await formatPass(await uniqueIdentity()),
      "https://broker",
    );
    const announce: Announce = {
      sessionId: "tmux-session",
      title: "tmux",
      cwd: null,
      sentAt: 1_000,
      freshnessAt: 1_000,
      incarnation: "host-1",
      incarnationStartedAt: 1_000,
      announceSeq: 0,
      status: "requires_action",
      phase: "idle",
      needs: true,
      git: null,
      harness: { agent: "claude-code", mode: "tmux" },
      capabilities: {
        structuredPermissions: false,
        permissionPosture: "local",
        textInput: "terminal",
        status: true,
        controls: { interrupt: false, setModel: false, setMode: false, end: false },
        attachments: true,
      },
    };
    const render = (mode?: string) =>
      renderToStaticMarkup(
        createElement(Transcript, {
          viewer,
          sessionId: announce.sessionId,
          title: announce.title,
          announce: { ...announce, ...(mode === undefined ? {} : { mode }) },
          now: 1_000,
          reconnectingSince: 0,
          onBack: () => {},
        }),
      );

    const local = render("default");
    expect(local).toContain("Input needed in the local terminal");
    expect(local).not.toContain("Permissions off");

    const bypassed = render("bypassPermissions");
    expect(bypassed).toContain("Permissions off");
    expect(bypassed).not.toContain("Input needed in the local terminal");

    // Rotation clears mode without rewriting the bridge's launch-time capability snapshot.
    const unknown = render();
    expect(unknown).toContain("Confirming permission mode in the local Claude tmux pane.");
    expect(unknown).not.toContain("Input needed in the local terminal");
    expect(unknown).not.toContain("Permissions off");
    expect(render("default")).toContain("Input needed in the local terminal");
  });

  it("keeps a present capability vector with missing or ill-typed status on compatibility UI", () => {
    const otherwiseStable = {
      structuredPermissions: false,
      controls: { interrupt: false, setModel: false, setMode: false, end: false },
      attachments: false,
    };
    const harness = { agent: "claude-code", mode: "rc" } as const;

    expect(isStableClaudeSurface(harness, parseCapabilities(otherwiseStable))).toBe(false);
    expect(
      isStableClaudeSurface(harness, parseCapabilities({ ...otherwiseStable, status: "idle" })),
    ).toBe(false);
    expect(
      isStableClaudeSurface(harness, parseCapabilities({ ...otherwiseStable, status: true })),
    ).toBe(true);
  });

  it("renders stable Claude permission/question history as local-only, never actionable/resolved", () => {
    const request: Message = {
      kind: "permission_request",
      seq: 2,
      msgId: "permission-2",
      text: JSON.stringify({
        request_id: "perm-1",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    };
    const resolved = new Map<string, "allow" | "deny">([["perm-1", "allow"]]);
    const html = renderBubble(
      request,
      { canGrant: false, permissionsLocal: true, hostConnected: true },
      resolved,
    );

    expect(html).toContain("Permission prompts are local to Claude");
    expect(html).toContain("Answer in the local Claude terminal");
    expect(html).not.toContain(">Allow<");
    expect(html).not.toContain(">Deny<");
    expect(html).not.toContain("Allowed");
  });

  it("renders OpenCode permission history as native/local, never disabled or remotely actionable", () => {
    const request: Message = {
      kind: "permission_request",
      seq: 3,
      msgId: "permission-3",
      text: JSON.stringify({ request_id: "perm-oc", tool_name: "Bash", tool_input: {} }),
    };
    const html = renderBubble(request, {
      canGrant: false,
      permissionsLocal: true,
      permissionAgent: "OpenCode",
      hostConnected: true,
    });

    expect(html).toContain("Permission prompts are local to OpenCode");
    expect(html).toContain("Answer in the local OpenCode TUI");
    expect(html).not.toContain("permissions off");
    expect(html).not.toContain(">Allow<");
    expect(html).not.toContain(">Deny<");
  });

  it("names both Codex approvals and questions as local native-TUI work", () => {
    const approval: Message = {
      kind: "permission_request",
      seq: 4,
      msgId: "permission-codex",
      text: JSON.stringify({ request_id: "perm-codex", tool_name: "Shell", tool_input: {} }),
    };
    const question: Message = {
      kind: "permission_request",
      seq: 5,
      msgId: "question-codex",
      text: JSON.stringify({
        request_id: "question-codex",
        tool_name: "request_user_input",
        tool_input: {
          questions: [
            {
              question: "Choose a path",
              header: "Path",
              options: [{ label: "Alpha", description: "Use Alpha" }],
              multiSelect: false,
            },
          ],
        },
      }),
    };
    const opts = {
      canGrant: false,
      permissionsLocal: true,
      permissionAgent: "Codex" as const,
      hostConnected: true,
    };
    const approvalHtml = renderBubble(approval, opts);
    const questionHtml = renderBubble(question, opts);

    expect(approvalHtml).toContain("Codex approval needed for Shell");
    expect(questionHtml).toContain("Codex has a local question");
    for (const html of [approvalHtml, questionHtml]) {
      expect(html).toContain("Approvals and questions are local to Codex");
      expect(html).toContain("Answer in the local Codex TUI");
      expect(html).not.toContain(">Allow<");
      expect(html).not.toContain(">Deny<");
      expect(html).not.toContain("q-options");
    }
  });

  it("keeps compatibility permission actions disabled whenever host presence is stale", () => {
    const request: Message = {
      kind: "permission_request",
      seq: 2,
      msgId: "permission-2",
      text: JSON.stringify({ request_id: "perm-1", tool_name: "Bash", tool_input: {} }),
    };
    const html = renderBubble(request, {
      canGrant: false,
      permissionsLocal: false,
      hostConnected: false,
    });

    expect(html).toContain("Reconnect to the host before answering");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  it("labels only host receipt, and gives ambiguous publication the frozen disclosure", () => {
    const pending = optimisticMessage("cm-1", "hello", []);
    const sending = renderBubble(pending);
    expect(sending).toContain(">Sending<");
    expect(sending).not.toContain("delivered");

    const unknown = renderBubble({ ...pending, deliveryUnknown: true });
    expect(unknown).toContain(
      "Delivery unknown — it may have reached the host. It was not retried.",
    );
    expect(unknown).not.toContain("Retry");

    const received = renderBubble(reconcileAccepted([pending], "cm-1", 7)[0] as Message);
    expect(received).toContain("Received by host");
    expect(received).not.toContain("Delivered");
    expect(received).not.toContain("executed");
  });
});
