import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_USER_CONTENT_CHARS } from "./anthropic/client.js";
import { NativePreviewBudget, NativeUploadStore } from "./native-uploads.js";
import { MAX_ATTACHMENT_B64, MAX_ATTACHMENT_TOTAL_BYTES } from "./relay.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof syncFs>()) }));

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), "rc-native-uploads-test-"));
  directories.push(directory);
  return directory;
}

function upload(name = "screen.png", mime = "image/png", data = "image bytes") {
  return { name, mime, data: Buffer.from(data).toString("base64") };
}

const signal = () => new AbortController().signal;
const paths = (text: string) =>
  [...(text.split("\n", 1)[0]?.matchAll(/@"([^"]+)"/g) ?? [])].map((match) => match[1] ?? "");

describe("NativePreviewBudget", () => {
  it("bounds decoded bytes across rows without charging skipped or malformed previews", () => {
    const budget = new NativePreviewBudget(5);
    const first = upload("first.png", "image/png", "abc");
    const remaining = upload("last.png", "image/png", "de");
    expect(budget.accept([first])).toEqual([first]);
    expect(budget.accept([first, { ...first, data: "!" }, remaining])).toEqual([remaining]);
    expect(budget.accept([upload("extra.png", "image/png", "f")])).toEqual([]);
    expect(first.data).toBe("YWJj");
  });

  it("caps the default lifetime allowance at 32 MiB", () => {
    const budget = new NativePreviewBudget();
    const image = {
      name: "one.png",
      mime: "image/png",
      data: Buffer.alloc(1024 * 1024).toString("base64"),
    };
    for (let group = 0; group < 4; group++)
      expect(budget.accept(Array(8).fill(image))).toHaveLength(8);
    expect(budget.accept([image])).toEqual([]);
    expect(new NativePreviewBudget(0).accept([image])).toEqual([]);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid limit %s", (limit) => {
    expect(() => new NativePreviewBudget(limit)).toThrow("byte limit");
  });
});

describe("NativeUploadStore", () => {
  it("writes private numbered mixed files, preserves content, and backfills previews without a manifest", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory);
    const inputs = [
      upload("report.PDF", "application/pdf", "%PDF-file"),
      upload("capture.jpeg", "image/png", "png bytes"),
      upload("main.ts", "text/plain", "const value = 1;"),
    ];
    const labels = "📎 report.PDF, 📎 capture.jpeg, 📎 main.ts\nDescribe these files";
    const prepared = await store.prepare(inputs, labels, signal());
    const files = paths(prepared.text);
    expect(files.map((file) => basename(file))).toEqual(["1.pdf", "2.png", "3.ts"]);
    expect(dirname(files[0] ?? "")).toMatch(/\/remote-claw-upload-[0-9a-f-]+$/);
    expect((await fs.stat(dirname(files[0] ?? ""))).mode & 0o777).toBe(0o700);
    for (const [index, file] of files.entries()) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.readFile(file)).toString("base64")).toBe(inputs[index]?.data);
    }
    expect(new NativeUploadStore(directory).display(prepared.text)).toEqual({
      text: labels,
      images: [{ name: "capture.jpeg", mime: "image/png", data: inputs[1]?.data }],
    });
    const second = await store.prepare([upload()], "📎 screen.png", signal());
    await prepared.discard();
    await prepared.discard();
    expect(await fs.readdir(directory)).toHaveLength(1);
    expect(store.display(prepared.text)).toEqual({ text: labels, images: [] });
    await second.discard();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("accepts zero-byte opaque files, not empty images, and uses a bounded safe suffix", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory);
    const empty = await store.prepare(
      [upload("empty.txt", "text/plain", "")],
      "📎 empty.txt",
      signal(),
    );
    expect((await fs.stat(paths(empty.text)[0] ?? "")).size).toBe(0);
    await empty.discard();
    const suffix = await store.prepare(
      [upload("README", "text/plain"), upload("file.abcdefghijklmn", "application/octet-stream")],
      "📎 README, 📎 file.abcdefghijklmn",
      signal(),
    );
    expect(paths(suffix.text).map((file) => basename(file))).toEqual(["1.bin", "2.bin"]);
    await suffix.discard();
    await expect(
      store.prepare([upload("screen.png", "image/png", "")], "📎 screen.png", signal()),
    ).rejects.toThrow("input");
  });

  it.each([
    ["unsafe filename", { ...upload(), name: "../screen.png" }],
    ["newline filename", { ...upload(), name: "screen\n.png" }],
    ["malformed base64", { ...upload(), data: "!!!!" }],
    ["base64 suffix", { ...upload(), data: "YQ==\n" }],
    ["unsafe MIME", { ...upload(), mime: "image/png\n" }],
  ])("rejects %s before creating any files", async (_label, malformed) => {
    const directory = await root();
    await expect(
      new NativeUploadStore(directory).prepare([malformed], "📎 screen.png", signal()),
    ).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("enforces encoded group, per-file, count and text bounds before writes", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory);
    await expect(store.prepare([], "", signal())).rejects.toThrow("group");
    await expect(store.prepare(Array(25).fill(upload()), "unused", signal())).rejects.toThrow(
      "group",
    );
    await expect(
      store.prepare(
        [{ ...upload(), data: "A".repeat(MAX_ATTACHMENT_B64 + 4) }],
        "📎 screen.png",
        signal(),
      ),
    ).rejects.toThrow("input");
    const full = { ...upload(), data: "A".repeat(MAX_ATTACHMENT_B64) };
    expect(full.data.length * 3).toBe(MAX_ATTACHMENT_TOTAL_BYTES);
    await expect(
      store.prepare([full, full, full], "📎 screen.png, 📎 screen.png, 📎 screen.png", signal()),
    ).rejects.toThrow("input");
    await expect(
      store.prepare([upload()], "📎 screen.png\n".padEnd(MAX_USER_CONTENT_CHARS, "a"), signal()),
    ).rejects.toThrow("native text limit");
    await expect(store.prepare([upload()], "wrong labels", signal())).rejects.toThrow(
      "display text",
    );
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("refuses unsafe configuration, symlink roots and non-private roots without changing modes", async () => {
    const directory = await root();
    for (const path of [
      "relative",
      `${directory}/quote"`,
      `${directory}/line\n`,
      `${directory}/back\\slash`,
      `${directory}/control\u0085`,
    ])
      expect(() => new NativeUploadStore(path)).toThrow("configuration");
    expect(() => new NativeUploadStore(directory, -1)).toThrow("configuration");
    const target = await root();
    const link = join(directory, "link");
    await fs.symlink(target, link);
    await expect(
      new NativeUploadStore(link).prepare([upload()], "📎 screen.png", signal()),
    ).rejects.toThrow();
    for (const mode of [0o755, 0o777]) {
      await fs.chmod(target, mode);
      await expect(
        new NativeUploadStore(target).prepare([upload()], "📎 screen.png", signal()),
      ).rejects.toThrow("unsafe");
      expect((await fs.stat(target)).mode & 0o777).toBe(mode);
    }
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("counts generated references in the exact native text limit without leaking reservations", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory, 1);
    const tiny = upload("one.txt", "text/plain", "a");
    const probe = await store.prepare([tiny], "📎 one.txt\n", signal());
    const prefixLength = probe.text.length - "📎 one.txt\n".length;
    await probe.discard();
    const maximum = "📎 one.txt\n".padEnd(MAX_USER_CONTENT_CHARS - prefixLength, "a");
    await expect(store.prepare([tiny], `${maximum}a`, signal())).rejects.toThrow(
      "native text limit",
    );
    expect(await fs.readdir(directory)).toEqual([]);
    const accepted = await store.prepare([tiny], maximum, signal());
    expect(accepted.text).toHaveLength(MAX_USER_CONTENT_CHARS);
    await accepted.discard();
  });

  it("cleans partial preparation, refunds bytes, and handles abort without orphaned uploads", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory, 2);
    const first = upload("one.txt", "text/plain", "a");
    const second = upload("two.txt", "text/plain", "b");
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith("/2.txt")) throw new Error("injected second-file failure");
      return originalOpen(path, flags, mode);
    });
    await expect(
      store.prepare([first, second], "📎 one.txt, 📎 two.txt", signal()),
    ).rejects.toThrow("injected");
    expect(await fs.readdir(directory)).toEqual([]);
    vi.restoreAllMocks();
    const controller = new AbortController();
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith("/1.txt")) controller.abort();
      return handle;
    });
    await expect(store.prepare([first], "📎 one.txt", controller.signal)).rejects.toThrow(
      "aborted",
    );
    expect(await fs.readdir(directory)).toEqual([]);
    await expect(store.prepare([first], "📎 one.txt", controller.signal)).rejects.toThrow(
      "aborted",
    );
    vi.restoreAllMocks();
    const prepared = await store.prepare([first, second], "📎 one.txt, 📎 two.txt", signal());
    await prepared.discard();
  });

  it("reserves cumulative bytes before filesystem awaits and refunds each group only once", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory, 1);
    const tiny = upload("one.txt", "text/plain", "a");
    const first = store.prepare([tiny], "📎 one.txt", signal());
    await expect(store.prepare([tiny], "📎 one.txt", signal())).rejects.toThrow("byte limit");
    const prepared = await first;
    await expect(store.prepare([tiny], "📎 one.txt", signal())).rejects.toThrow("byte limit");
    await prepared.discard();
    await prepared.discard();
    const next = await store.prepare([tiny], "📎 one.txt", signal());
    await expect(store.prepare([tiny], "📎 one.txt", signal())).rejects.toThrow("byte limit");
    await next.discard();
  });

  it("does not overwrite or remove a file collision that it did not create", async () => {
    const directory = await root();
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith("/1.png"))
        await fs.writeFile(path, "preserve collision", { flag: "wx", mode: 0o600 });
      return originalOpen(path, flags, mode);
    });
    await expect(
      new NativeUploadStore(directory).prepare([upload()], "📎 screen.png", signal()),
    ).rejects.toThrow();
    const group = (await fs.readdir(directory))[0] ?? "";
    expect(await fs.readFile(join(directory, group, "1.png"), "utf8")).toBe("preserve collision");
  });

  it("leaves arbitrary paths and malformed generated groups completely untouched without reads", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory);
    const group = `${directory}/remote-claw-upload-11111111-1111-4111-8111-111111111111`;
    const native = `@"${group}/1.png" @"${group}/2.jpg"\n📎 one.png, 📎 two.jpg\ncaption`;
    const reads = vi.spyOn(syncFs, "openSync");
    for (const invalid of [
      native.replace("/2.jpg", "/3.jpg"),
      native.replace("/1.png", "/01.png"),
      native.replace("remote-claw-upload-", "other-"),
      native.replace("/1.png", "/../1.png"),
      native.replace('" @"', '"  @"'),
      native.replace("📎 one.png", "📎 ../one.png"),
      native.replace(", 📎 two.jpg", ""),
      `ordinary ${native}`,
      '@"/unrelated/secret.png"\n📎 secret.png',
    ])
      expect(store.display(invalid)).toEqual({ text: invalid, images: [] });
    expect(reads).not.toHaveBeenCalled();
  });

  it("supports more labels than refs without inventing a name-to-preview mapping", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory);
    const labels = "📎 inline.png, 📎 file.png\ncaption";
    const prepared = await store.prepare([upload("file.png")], labels, signal());
    const reads = vi.spyOn(syncFs, "openSync");
    expect(store.display(prepared.text)).toEqual({ text: labels, images: [] });
    expect(reads).not.toHaveBeenCalled();
    await prepared.discard();
  });

  it("reads exact private legacy image groups, never legacy non-image references", async () => {
    const directory = await root();
    const group = join(directory, "remote-claw-native-11111111-1111-4111-8111-111111111111");
    await fs.mkdir(group, { mode: 0o700 });
    await fs.writeFile(join(group, "1.png"), "legacy bytes", { mode: 0o600 });
    const native = `@"${group}/1.png"\n📎 legacy.png`;
    expect(new NativeUploadStore(directory).display(native)).toEqual({
      text: "📎 legacy.png",
      images: [upload("legacy.png", "image/png", "legacy bytes")],
    });
    const invalid = native.replace("/1.png", "/1.pdf");
    expect(new NativeUploadStore(directory).display(invalid)).toEqual({
      text: invalid,
      images: [],
    });
  });

  it("skips unsafe image files, hardlinks, directories and symlink parents without reading their bytes", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory);
    const prepared = await store.prepare([upload()], "📎 screen.png", signal());
    const path = paths(prepared.text)[0] ?? "";
    const group = dirname(path);
    const secret = join(await root(), "secret.png");
    await fs.writeFile(secret, "unrelated", { mode: 0o600 });
    const reads = vi.spyOn(syncFs, "readSync");
    await fs.chmod(path, 0o644);
    expect(store.display(prepared.text)).toEqual({ text: "📎 screen.png", images: [] });
    await fs.unlink(path);
    await fs.symlink(secret, path);
    expect(store.display(prepared.text)).toEqual({ text: "📎 screen.png", images: [] });
    await fs.unlink(path);
    await fs.link(secret, path);
    expect(store.display(prepared.text)).toEqual({ text: "📎 screen.png", images: [] });
    await fs.unlink(path);
    await fs.mkdir(path, { mode: 0o700 });
    expect(store.display(prepared.text)).toEqual({ text: "📎 screen.png", images: [] });
    await fs.rmdir(path);
    await fs.rmdir(group);
    await fs.symlink(dirname(secret), group);
    expect(store.display(prepared.text)).toEqual({ text: "📎 screen.png", images: [] });
    expect(reads).not.toHaveBeenCalled();
    expect(await fs.readFile(secret, "utf8")).toBe("unrelated");
  });

  it("does not read previews from roots or groups with unsafe owner or permissions", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory);
    const prepared = await store.prepare([upload()], "📎 screen.png", signal());
    const group = dirname(paths(prepared.text)[0] ?? "");
    const reads = vi.spyOn(syncFs, "readSync");
    await fs.chmod(directory, 0o755);
    expect(store.display(prepared.text)).toEqual({ text: "📎 screen.png", images: [] });
    await fs.chmod(directory, 0o700);
    await fs.chmod(group, 0o755);
    expect(store.display(prepared.text)).toEqual({ text: "📎 screen.png", images: [] });
    await fs.chmod(group, 0o700);
    const originalStat = syncFs.fstatSync;
    vi.spyOn(syncFs, "fstatSync").mockImplementation((fd) => {
      const stat = originalStat(fd);
      stat.uid += 1;
      return stat;
    });
    expect(store.display(prepared.text)).toEqual({ text: "📎 screen.png", images: [] });
    expect(reads).not.toHaveBeenCalled();
    await prepared.discard();
  });

  it("limits previews to eight 1 MiB images and preserves all labels", async () => {
    const directory = await root();
    const store = new NativeUploadStore(directory);
    const inputs = Array.from({ length: 10 }, (_, index) =>
      upload(`${index}.png`, "image/png", "x".repeat(1024 * 1024)),
    );
    const labels = inputs.map((input) => `📎 ${input.name}`).join(", ");
    const prepared = await store.prepare(inputs, labels, signal());
    const result = store.display(prepared.text);
    expect(result.text).toBe(labels);
    expect(result.images).toHaveLength(8);
    expect(
      result.images.every((image) => Buffer.from(image.data, "base64").length === 1024 * 1024),
    ).toBe(true);
    const first = paths(prepared.text)[0] ?? "";
    await fs.appendFile(first, "too large");
    expect(store.display(prepared.text).images[0]?.name).toBe("1.png");
    await prepared.discard();
  });
});
