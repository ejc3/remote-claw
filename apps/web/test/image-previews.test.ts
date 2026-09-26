import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUserAttachment } from "../app/lib/viewer.js";
import { createImagePreviews } from "../app/page.js";

const image = { name: "photo.png", mime: "image/png", data: "QUJDRA==" };
const parse = (images: unknown, text = "photo.png\nA caption") =>
  parseUserAttachment(JSON.stringify({ text, images }));

afterEach(() => vi.restoreAllMocks());

describe("canonical image previews", () => {
  it("keeps caption/filename text and decodes only bounded canonical base64 image bytes", () => {
    expect(parse([image])).toEqual({ text: "photo.png\nA caption", images: [image] });
    expect(parse([{ ...image, name: "dir/photo\n.png" }]).images?.[0]?.name).toBe("dir_photo_.png");
  });

  it.each([
    { ...image, mime: "image/svg+xml" },
    { ...image, mime: "text/html" },
    { ...image, data: "https://example.test/photo.png" },
    { ...image, data: "data:image/png;base64,QUJDRA==" },
    { ...image, data: "QUJDRA" },
    { ...image, data: "QR==" },
    { ...image, data: "" },
    { ...image, url: "https://example.test/photo.png" },
    null,
  ])("discards invalid preview without discarding caption: %j", (invalid) => {
    expect(parse([invalid])).toEqual({ text: "photo.png\nA caption" });
  });

  it("enforces decoded per-image and group count bounds", () => {
    const atLimit = Buffer.alloc(1024 * 1024).toString("base64");
    expect(parse([{ ...image, data: atLimit }]).images).toHaveLength(1);
    const data = Buffer.alloc(1024 * 1024 + 1).toString("base64");
    expect(parse([{ ...image, data }]).images).toBeUndefined();
    expect(parse(Array(8).fill(image)).images).toHaveLength(8);
    expect(parse(Array(9).fill(image)).images).toBeUndefined();
  });

  it("does not render malformed JSON as a user message or leak its payload", () => {
    expect(parseUserAttachment("{bad")).toEqual({ text: "[Attachment preview unavailable]" });
    expect(parseUserAttachment(JSON.stringify({ text: 7, images: [image] }))).toEqual({
      text: "[Attachment preview unavailable]",
    });
  });

  it("allocates local typed blobs and releases every URL when the row owner disposes", async () => {
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:one")
      .mockReturnValueOnce("blob:two");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const owned = createImagePreviews([image, { ...image, name: "second.png" }]);
    const blob = create.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("ABCD");
    expect(owned.previews.map((preview) => preview.url)).toEqual(["blob:one", "blob:two"]);
    owned.release();
    expect(revoke.mock.calls).toEqual([["blob:one"], ["blob:two"]]);
  });

  it("releases already-created URLs if a later image allocation fails", () => {
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:one")
      .mockImplementationOnce(() => {
        throw new Error("allocation failed");
      });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    expect(() => createImagePreviews([image, image])).toThrow("allocation failed");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:one");
  });
});
