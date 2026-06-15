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
  it("text only → one prompt, no attachments", async () => {
    const v = mockViewer();
    await sendComposer(v, "cse_x", "hello", [], async () => "DATA");
    expect(v.sendPrompt).toHaveBeenCalledWith("cse_x", "hello");
    expect(v.sendAttachment).not.toHaveBeenCalled();
  });

  it("staged images → one attachment per image (text as caption), and NO separate prompt", async () => {
    const v = mockViewer();
    const staged = [
      { id: "1", name: "a.jpg", file: img("a.jpg"), url: "blob:a" },
      { id: "2", name: "b.jpg", file: img("b.jpg"), url: "blob:b" },
    ];
    const downscale = vi.fn(async () => "DOWNSCALED");
    await sendComposer(v, "cse_x", "what is this", staged, downscale);
    expect(downscale).toHaveBeenCalledTimes(2);
    expect(v.sendAttachment).toHaveBeenCalledTimes(2);
    expect(v.sendAttachment).toHaveBeenNthCalledWith(1, "cse_x", {
      name: "a.jpg",
      mime: "image/jpeg",
      data: "DOWNSCALED",
      caption: "what is this",
    });
    expect(v.sendPrompt).not.toHaveBeenCalled();
  });

  it("empty (no text, no staged) → no network calls", async () => {
    const v = mockViewer();
    await sendComposer(v, "cse_x", "", [], async () => "D");
    expect(v.sendPrompt).not.toHaveBeenCalled();
    expect(v.sendAttachment).not.toHaveBeenCalled();
  });
});
