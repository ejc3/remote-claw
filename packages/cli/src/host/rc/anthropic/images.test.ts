import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_B64, MAX_ATTACHMENT_TOTAL_BYTES } from "../relay.js";
import { MAX_USER_CONTENT_CHARS } from "./client.js";
import { NativeImageStore } from "./images.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), "rc-native-images-test-"));
  directories.push(directory);
  return directory;
}

function image(name = "image.png", mime = "image/png", data = "image bytes") {
  return { name, url: `data:${mime};base64,${Buffer.from(data).toString("base64")}` };
}

const signal = () => new AbortController().signal;
const paths = (text: string) =>
  [...(text.split("\n", 1)[0]?.matchAll(/@"([^"]+)"/g) ?? [])].map((match) => match[1] ?? "");

describe("NativeImageStore", () => {
  it("prepares private numbered MIME files, preserves bytes, and discards only its own group", async () => {
    const directory = await root();
    await fs.chmod(directory, 0o755); // A searchable root is safe; its fresh children remain private.
    const store = new NativeImageStore(directory);
    const input = [
      image("../screen.png", "image/jpeg", "one"),
      image("other.png", "image/png", "two"),
    ];
    const labels = "📎 screen.png, 📎 other.png\nDescribe these";
    const prepared = await store.prepare(input, labels, signal());
    const files = paths(prepared.text);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/\/remote-claw-native-[0-9a-f-]+\/1\.jpg$/);
    expect(files[1]).toBe(join(dirname(files[0] ?? ""), "2.png"));
    expect((await fs.stat(dirname(files[0] ?? ""))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(files[0] ?? "")).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(files[0] ?? "", "utf8")).toBe("one");
    expect(await fs.readFile(files[1] ?? "", "utf8")).toBe("two");
    expect(prepared.text.endsWith(`\n${labels}`)).toBe(true);
    expect(new NativeImageStore(directory).displayText(prepared.text)).toBe(labels);

    const next = await store.prepare([image()], "📎 image.png", signal());
    expect(dirname(paths(next.text)[0] ?? "")).not.toBe(dirname(files[0] ?? ""));
    await prepared.discard();
    await prepared.discard();
    expect(await fs.readdir(directory)).toHaveLength(1);
    expect(await fs.readFile(paths(next.text)[0] ?? "", "utf8")).toBe("image bytes");
    await next.discard();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([
    ["remote URL", { name: "image.png", url: "https://example.test/image.png" }],
    ["unsupported MIME", image("image.svg", "image/svg+xml")],
    ["malformed base64", { name: "image.png", url: "data:image/png;base64,!!!!" }],
    ["base64 suffix", { name: "image.png", url: "data:image/png;base64,YQ==\n" }],
    ["empty base64", { name: "image.png", url: "data:image/png;base64," }],
  ])("validates the complete group before writing: %s", async (_label, malformed) => {
    const directory = await root();
    const store = new NativeImageStore(directory);
    const input = [image("good.png"), malformed];
    await expect(
      store.prepare(input, `📎 good.png, 📎 ${malformed.name}`, signal()),
    ).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("rejects per-image, count, and whole-group URL bounds before filesystem changes", async () => {
    const directory = await root();
    const store = new NativeImageStore(directory);
    await expect(store.prepare([], "", signal())).rejects.toThrow("invalid native image group");
    await expect(store.prepare(Array(25).fill(image()), "unused", signal())).rejects.toThrow(
      "invalid native image group",
    );
    const oversized = {
      name: "image.png",
      url: `data:image/png;base64,${"A".repeat(MAX_ATTACHMENT_B64 + 4)}`,
    };
    await expect(store.prepare([oversized], "📎 image.png", signal())).rejects.toThrow(
      "invalid native image input",
    );
    const full = {
      name: "image.png",
      url: `data:image/png;base64,${"A".repeat(MAX_ATTACHMENT_B64)}`,
    };
    expect(Buffer.byteLength(full.url) * 3).toBeGreaterThan(MAX_ATTACHMENT_TOTAL_BYTES);
    await expect(
      store.prepare([full, full, full], "📎 image.png, 📎 image.png, 📎 image.png", signal()),
    ).rejects.toThrow("invalid native image input");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("rejects invalid display text and unsafe root configuration", async () => {
    const directory = await root();
    await expect(
      new NativeImageStore(directory).prepare([image()], "wrong label", signal()),
    ).rejects.toThrow("display text");
    for (const path of [
      "relative",
      `${directory}/quote"`,
      `${directory}/line\n`,
      `${directory}/back\\slash`,
    ]) {
      expect(() => new NativeImageStore(path)).toThrow("configuration");
    }
    expect(() => new NativeImageStore(directory, -1)).toThrow("configuration");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("counts generated references in the native text limit before writing or reserving bytes", async () => {
    const directory = await root();
    const input = image("image.png", "image/png", "a");
    const store = new NativeImageStore(directory, 1);
    const probe = await store.prepare([input], "📎 image.png\n", signal());
    const prefixLength = probe.text.length - "📎 image.png\n".length;
    await probe.discard();
    const maximum = "📎 image.png\n".padEnd(MAX_USER_CONTENT_CHARS - prefixLength, "a");
    await expect(store.prepare([input], `${maximum}a`, signal())).rejects.toThrow(
      "native text limit",
    );
    expect(await fs.readdir(directory)).toEqual([]);
    const accepted = await store.prepare([input], maximum, signal());
    expect(accepted.text).toHaveLength(MAX_USER_CONTENT_CHARS);
    await accepted.discard();
  });

  it("refuses symlink and writable roots without changing their posture", async () => {
    const directory = await root();
    const target = await root();
    const link = join(directory, "symlink");
    await fs.symlink(target, link);
    await expect(
      new NativeImageStore(link).prepare([image()], "📎 image.png", signal()),
    ).rejects.toThrow("unsafe");
    expect(await fs.readdir(target)).toEqual([]);
    await fs.chmod(target, 0o777);
    await expect(
      new NativeImageStore(target).prepare([image()], "📎 image.png", signal()),
    ).rejects.toThrow("unsafe");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o777);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("does not overwrite an existing numbered file or remove unowned collision data", async () => {
    const directory = await root();
    const originalOpen = fs.open;
    let collision = "";
    vi.spyOn(fs, "open").mockImplementationOnce(async (path, flags, mode) => {
      collision = String(path);
      await fs.writeFile(path, "preserve collision", { flag: "wx", mode: 0o600 });
      return originalOpen(path, flags, mode);
    });
    await expect(
      new NativeImageStore(directory).prepare([image()], "📎 image.png", signal()),
    ).rejects.toThrow();
    expect(await fs.readFile(collision, "utf8")).toBe("preserve collision");
  });

  it("cleans partial preparation and refunds only its never-submitted reservation", async () => {
    const directory = await root();
    const store = new NativeImageStore(directory, 2);
    const originalOpen = fs.open;
    vi.spyOn(fs, "open")
      .mockImplementationOnce((...args) => originalOpen(...args))
      .mockRejectedValueOnce(new Error("injected second-file failure"));
    const one = image("one.png", "image/png", "a");
    const two = image("two.png", "image/png", "b");
    await expect(store.prepare([one, two], "📎 one.png, 📎 two.png", signal())).rejects.toThrow(
      "injected second-file failure",
    );
    expect(await fs.readdir(directory)).toEqual([]);
    const prepared = await store.prepare([one, two], "📎 one.png, 📎 two.png", signal());
    await prepared.discard();
  });

  it("cleans up an abort during preparation and rejects an already aborted request", async () => {
    const directory = await root();
    const store = new NativeImageStore(directory, 1);
    const controller = new AbortController();
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      controller.abort();
      return handle;
    });
    const tiny = image("image.png", "image/png", "a");
    await expect(store.prepare([tiny], "📎 image.png", controller.signal)).rejects.toThrow(
      "aborted",
    );
    expect(await fs.readdir(directory)).toEqual([]);
    await expect(store.prepare([tiny], "📎 image.png", controller.signal)).rejects.toThrow(
      "aborted",
    );
    const prepared = await store.prepare([tiny], "📎 image.png", signal());
    await prepared.discard();
  });

  it("reserves cumulative bytes before awaits and keeps prepared groups charged until discarded", async () => {
    const directory = await root();
    const store = new NativeImageStore(directory, 1);
    const tiny = image("image.png", "image/png", "a");
    const first = store.prepare([tiny], "📎 image.png", signal());
    await expect(store.prepare([tiny], "📎 image.png", signal())).rejects.toThrow("byte limit");
    const prepared = await first;
    await expect(store.prepare([tiny], "📎 image.png", signal())).rejects.toThrow("byte limit");
    await prepared.discard();
    await prepared.discard();
    const replacement = await store.prepare([tiny], "📎 image.png", signal());
    await expect(store.prepare([tiny], "📎 image.png", signal())).rejects.toThrow("byte limit");
    await replacement.discard();
  });

  it("normalizes only exact generated contiguous same-directory groups with canonical labels", async () => {
    const directory = await root();
    const store = new NativeImageStore(directory);
    const uuid = "11111111-1111-4111-8111-111111111111";
    const prefix = `${directory}/remote-claw-native-${uuid}`;
    const native = `@"${prefix}/1.png" @"${prefix}/2.jpg"\n📎 one.png, 📎 two.jpg\ncaption`;
    expect(store.displayText(native)).toBe("📎 one.png, 📎 two.jpg\ncaption");
    for (const invalid of [
      native.replace("/2.jpg", "/3.jpg"),
      native.replace("/1.png", "/01.png"),
      native.replace("/1.png", "/1.txt"),
      native.replace("remote-claw-native-", "other-"),
      native.replace(uuid, "not-a-uuid"),
      native.replace("/1.png", "/../1.png"),
      native.replace('" @"', '"  @"'),
      native.replace("\n📎", " 📎"),
      native.replace("📎 one.png", "plain caption"),
      native.replace("📎 one.png", "📎 ../one.png"),
      native.replace(", 📎 two.jpg", ""),
      `ordinary text ${native}`,
      `@"/unrelated/1.png"\n📎 one.png`,
    ])
      expect(store.displayText(invalid)).toBe(invalid);
    expect(await fs.readdir(directory)).toEqual([]); // Pure normalization performs no filesystem reads.
  });
});
