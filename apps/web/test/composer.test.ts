import { describe, expect, it, vi } from "vitest";
import type { Viewer } from "../app/lib/viewer.js";
import { restageImages, sendComposer } from "../app/page.js";

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

// #150 send-failure resilience: on a failed send the draft is restored to the composer. The original
// object URLs are revoked when the composer was optimistically cleared, so restored previews need FRESH
// URLs minted from the (still-valid) File — restageImages does that, keeping id/name/file stable.
describe("restageImages", () => {
  it("mints a fresh object URL per image from the File, preserving id/name/file", () => {
    const fileA = img("a.jpg");
    const fileB = img("b.jpg");
    const failed = [
      { id: "1", name: "a.jpg", file: fileA, url: "blob:revoked-a" },
      { id: "2", name: "b.jpg", file: fileB, url: "blob:revoked-b" },
    ];
    const makeUrl = vi.fn((f: File) => `blob:fresh-${f.name}`);
    const out = restageImages(failed, makeUrl);
    expect(makeUrl).toHaveBeenCalledTimes(2);
    expect(makeUrl).toHaveBeenNthCalledWith(1, fileA);
    expect(out).toEqual([
      { id: "1", name: "a.jpg", file: fileA, url: "blob:fresh-a.jpg" },
      { id: "2", name: "b.jpg", file: fileB, url: "blob:fresh-b.jpg" },
    ]);
    // a fresh URL replaces the revoked one (the whole point — the old preview is dead)
    expect(out[0]?.url).not.toBe(failed[0]?.url);
  });

  it("returns an empty list for no images (a text-only failed send restores no previews)", () => {
    expect(restageImages([], () => "blob:x")).toEqual([]);
  });
});
