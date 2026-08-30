import { describe, expect, it, vi } from "vitest";
import type { Viewer } from "../app/lib/viewer.js";
import {
  composerTextForSend,
  enterShouldSend,
  fitStaged,
  isOpenCodeNativeTextSurface,
  isStableClaudeSurface,
  isSupportedOpenCodeSurface,
  remoteMutationEnabled,
  reportsWorkerStatus,
  sendComposer,
  shouldClearOptimisticMode,
  stableTextBlockReason,
} from "../app/page.js";

// Composer send-on-submit (#108/#112): attachments are STAGED then sent together with the text on submit
// (no auto-send on file pick). sendComposer is the extracted, DOM-free core.
const img = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
const mockViewer = () =>
  ({
    sendPrompt: vi.fn(async () => "m"),
    sendAttachment: vi.fn(async () => "a"),
  }) as unknown as Pick<Viewer, "sendAttachment" | "sendPrompt"> & {
    sendPrompt: ReturnType<typeof vi.fn>;
    sendAttachment: ReturnType<typeof vi.fn>;
  };

describe("sendComposer", () => {
  it("text only → one prompt threaded with the clientMsgId, no attachments", async () => {
    const v = mockViewer();
    await sendComposer(v, "cse_x", "hello", [], async () => "DATA", "cm-1");
    expect(v.sendPrompt).toHaveBeenCalledWith("cse_x", "hello", "cm-1"); // clientMsgId threaded (#113)
    expect(v.sendAttachment).not.toHaveBeenCalled();
  });

  it("staged images → ONE grouped attachment (all images + caption once), threaded clientMsgId (#113/#114)", async () => {
    const v = mockViewer();
    const staged = [
      { id: "1", name: "a.jpg", file: img("a.jpg"), url: "blob:a" },
      { id: "2", name: "b.jpg", file: img("b.jpg"), url: "blob:b" },
    ];
    const downscale = vi.fn(async () => "DOWNSCALED");
    await sendComposer(v, "cse_x", "what is this", staged, downscale, "cm-2");
    expect(downscale).toHaveBeenCalledTimes(2);
    // One grouped call carrying BOTH images and the caption ONCE — not one frame per image.
    expect(v.sendAttachment).toHaveBeenCalledTimes(1);
    expect(v.sendAttachment).toHaveBeenCalledWith(
      "cse_x",
      {
        images: [
          { name: "a.jpg", mime: "image/jpeg", data: "DOWNSCALED" },
          { name: "b.jpg", mime: "image/jpeg", data: "DOWNSCALED" },
        ],
        caption: "what is this",
      },
      "cm-2", // clientMsgId threaded so the optimistic echo reconciles on the accepted ack
    );
    expect(v.sendPrompt).not.toHaveBeenCalled();
  });

  it("empty (no text, no staged) → no network calls", async () => {
    const v = mockViewer();
    await sendComposer(v, "cse_x", "", [], async () => "D", "cm-3");
    expect(v.sendPrompt).not.toHaveBeenCalled();
    expect(v.sendAttachment).not.toHaveBeenCalled();
  });
});

describe("stable Claude mutation surface", () => {
  const textOnlyCaps = {
    structuredPermissions: false,
    controls: { interrupt: false, setModel: false, setMode: false, end: false },
    attachments: false,
  };
  const privateRelayCaps = { ...textOnlyCaps, status: true };
  const nativeCompanionCaps = { ...textOnlyCaps, status: false };

  it("recognizes the exact private-relay and native-companion text-only tuples", () => {
    expect(isStableClaudeSurface({ agent: "claude-code", mode: "rc" }, privateRelayCaps)).toBe(
      true,
    );
    expect(
      isStableClaudeSurface({ agent: "claude-code", mode: "native-rc" }, nativeCompanionCaps),
    ).toBe(true);
    expect(isStableClaudeSurface({ agent: "claude-code", mode: "rc" }, nativeCompanionCaps)).toBe(
      false,
    );
    expect(
      isStableClaudeSurface({ agent: "claude-code", mode: "native-rc" }, privateRelayCaps),
    ).toBe(false);
    expect(
      isStableClaudeSurface(
        { agent: "claude-code", mode: "rc" },
        { ...privateRelayCaps, attachments: true },
      ),
    ).toBe(false);
    expect(
      isStableClaudeSurface(
        { agent: "claude-code", mode: "rc" },
        { ...privateRelayCaps, structuredPermissions: true },
      ),
    ).toBe(false);
    for (const control of ["interrupt", "setModel", "setMode", "end"] as const) {
      expect(
        isStableClaudeSurface(
          { agent: "claude-code", mode: "native-rc" },
          {
            ...nativeCompanionCaps,
            controls: { ...nativeCompanionCaps.controls, [control]: true },
          },
        ),
      ).toBe(false);
    }
    expect(isStableClaudeSurface({ agent: "claude-code", mode: "tmux" }, privateRelayCaps)).toBe(
      false,
    );
    expect(isStableClaudeSurface({ agent: "claude-code", mode: "rc" }, undefined)).toBe(false);
  });

  it("rejects trimmed empty/slash text on stable Claude but preserves compatibility slash text", () => {
    expect(stableTextBlockReason("   ", true)).toBe("empty");
    expect(stableTextBlockReason("  /compact  ", true)).toBe("slash");
    expect(stableTextBlockReason("//still slash-prefixed", true)).toBe("slash");
    expect(stableTextBlockReason("use /compact later", true)).toBeNull();
    expect(stableTextBlockReason(" /compact ", false)).toBeNull();
  });

  it("requires fresh connected presence in addition to capability support", () => {
    expect(remoteMutationEnabled(true, true)).toBe(true);
    expect(remoteMutationEnabled(false, true)).toBe(false);
    expect(remoteMutationEnabled(true, false)).toBe(false);
  });

  it("suppresses worker-status claims only when the host explicitly lacks fidelity", () => {
    expect(reportsWorkerStatus(nativeCompanionCaps)).toBe(false);
    expect(reportsWorkerStatus(privateRelayCaps)).toBe(true);
    expect(reportsWorkerStatus(undefined)).toBe(true);
  });
});

describe("supported OpenCode mutation surface", () => {
  const caps = {
    structuredPermissions: false,
    status: false,
    controls: { interrupt: true, setModel: false, setMode: false, end: false },
    attachments: false,
  };
  const harness = { agent: "opencode", mode: "opencode" } as const;

  it("recognizes only the exact native text-plus-interrupt tuple", () => {
    expect(isOpenCodeNativeTextSurface(harness, caps)).toBe(true);
    expect(isSupportedOpenCodeSurface(harness, caps)).toBe(true);
    expect(reportsWorkerStatus(caps)).toBe(false);
    expect(isSupportedOpenCodeSurface({ agent: "claude-code", mode: "rc" }, caps)).toBe(false);
    expect(isSupportedOpenCodeSurface(harness, { ...caps, structuredPermissions: true })).toBe(
      false,
    );
    expect(isOpenCodeNativeTextSurface(harness, { ...caps, structuredPermissions: true })).toBe(
      true,
    );
    expect(isSupportedOpenCodeSurface(harness, { ...caps, status: true })).toBe(false);
    expect(isSupportedOpenCodeSurface(harness, { ...caps, attachments: true })).toBe(false);
    for (const control of ["setModel", "setMode", "end"] as const) {
      expect(
        isSupportedOpenCodeSurface(harness, {
          ...caps,
          controls: { ...caps.controls, [control]: true },
        }),
      ).toBe(false);
    }
    expect(
      isSupportedOpenCodeSurface(harness, {
        ...caps,
        controls: { ...caps.controls, interrupt: false },
      }),
    ).toBe(false);
    expect(isSupportedOpenCodeSurface(harness, undefined)).toBe(false);
  });

  it("blocks trimmed-empty and slash-prefixed input while admitting ordinary text", () => {
    expect(stableTextBlockReason(" \n\t ", true)).toBe("empty");
    expect(stableTextBlockReason(" \t/compact \n", true)).toBe("slash");
    expect(stableTextBlockReason("  preserve these edges  ", true)).toBeNull();
  });

  it("preserves every admitted OpenCode text byte at the send boundary", () => {
    expect(composerTextForSend(" \tkeep both edges\n ", true)).toBe(" \tkeep both edges\n ");
    expect(composerTextForSend("  compatibility trim  ", false)).toBe("compatibility trim");
  });
});

describe("supported Codex mutation surface", () => {
  const caps = {
    structuredPermissions: false,
    status: true,
    controls: { interrupt: false, setModel: false, setMode: false, end: false },
    attachments: false,
  };
  it("uses real worker status and the shared native text admission guard", () => {
    expect(reportsWorkerStatus(caps)).toBe(true);
    expect(stableTextBlockReason(" \n\t ", true)).toBe("empty");
    expect(stableTextBlockReason(" /review ", true)).toBe("slash");
    expect(stableTextBlockReason("review this change", true)).toBeNull();
  });
});

// #151 mobile a11y: on a coarse (touch) pointer, Enter is a NEWLINE (the Send button sends); on a fine
// (desktop) pointer Enter sends and Shift+Enter is a line break.
describe("enterShouldSend", () => {
  it("desktop (fine pointer): Enter sends, Shift+Enter does not", () => {
    expect(enterShouldSend({ key: "Enter", shiftKey: false }, false)).toBe(true);
    expect(enterShouldSend({ key: "Enter", shiftKey: true }, false)).toBe(false);
  });
  it("touch (coarse pointer): Enter NEVER sends (it's a newline)", () => {
    expect(enterShouldSend({ key: "Enter", shiftKey: false }, true)).toBe(false);
    expect(enterShouldSend({ key: "Enter", shiftKey: true }, true)).toBe(false);
  });
  it("a non-Enter key never sends", () => {
    expect(enterShouldSend({ key: "a", shiftKey: false }, false)).toBe(false);
  });
  // #H IME guard: Enter during composition COMMITS a candidate (isComposing===true) — it must not send a
  // half-composed message. Without the guard a Japanese/Chinese/Korean user couldn't type at all.
  it("Enter while an IME is composing never sends (even on desktop)", () => {
    expect(enterShouldSend({ key: "Enter", shiftKey: false, isComposing: true }, false)).toBe(
      false,
    );
    expect(enterShouldSend({ key: "Enter", shiftKey: false, isComposing: false }, false)).toBe(
      true,
    );
  });
});

// #H staged-image cap: bound the number of staged images so a runaway pick can't balloon the array + its
// object URLs. fitStaged is the pure decision (accept how many, drop how many) used by addStaged.
describe("fitStaged", () => {
  it("accepts all when there's room", () => {
    expect(fitStaged(0, 3, 24)).toEqual({ accept: 3, dropped: 0 });
    expect(fitStaged(20, 4, 24)).toEqual({ accept: 4, dropped: 0 });
  });
  it("drops the overflow past the cap", () => {
    expect(fitStaged(22, 5, 24)).toEqual({ accept: 2, dropped: 3 });
    expect(fitStaged(0, 30, 24)).toEqual({ accept: 24, dropped: 6 });
  });
  it("accepts nothing when already at/over the cap", () => {
    expect(fitStaged(24, 3, 24)).toEqual({ accept: 0, dropped: 3 });
    expect(fitStaged(25, 1, 24)).toEqual({ accept: 0, dropped: 1 });
  });
});

// #H optimistic permission-mode reconcile: avoid the flicker where a keepalive announce still carrying the
// PRE-PICK mode would flash the old mode back before the host applies our set_mode.
describe("shouldClearOptimisticMode", () => {
  it("keeps the pick while the announce still echoes the pre-pick mode (the flicker we prevent)", () => {
    // picked "plan", was "default"; a keepalive still says "default" → keep "plan"
    expect(shouldClearOptimisticMode("default", "plan", "default")).toBe(false);
  });
  it("clears once the announce CONFIRMS the pick", () => {
    expect(shouldClearOptimisticMode("plan", "plan", "default")).toBe(true);
  });
  it("clears on a genuine remote change to a third value", () => {
    // someone else set "auto" — neither our pick ("plan") nor the pre-pick value ("default") → yield
    expect(shouldClearOptimisticMode("auto", "plan", "default")).toBe(true);
  });
  it("no-ops when there's no optimistic pick, or the announce carries no mode", () => {
    expect(shouldClearOptimisticMode("default", null, "default")).toBe(false);
    expect(shouldClearOptimisticMode(undefined, "plan", "default")).toBe(false);
  });
});
