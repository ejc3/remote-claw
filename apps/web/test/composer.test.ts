import { describe, expect, it, vi } from "vitest";
import type { Viewer } from "../app/lib/viewer.js";
import { sendComposer } from "../app/page.js";

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
