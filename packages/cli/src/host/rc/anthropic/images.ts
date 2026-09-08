import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  extForMime,
  isLikelyBase64,
  MAX_ATTACHMENT_B64,
  MAX_ATTACHMENT_IMAGES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  safeAttachmentName,
} from "../relay.js";
import type { HostImage } from "../session.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("native image preparation aborted");
}

export interface PreparedNativeImages {
  text: string;
  /** Call only when no native POST was attempted; an ambiguous submission still needs its files. */
  discard(): Promise<void>;
}

/** Private image files remain available to native Claude after the companion stops. No background GC. */
export class NativeImageStore {
  readonly #root: string;
  readonly #byteLimit: number;
  readonly #reference: RegExp;
  #reservedBytes = 0;

  constructor(root = join(homedir(), ".remote-claw-uploads"), byteLimit = 256 * 1024 * 1024) {
    if (
      !isAbsolute(root) ||
      [...root].some(
        (char) =>
          char === '"' || char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) ||
      !Number.isSafeInteger(byteLimit) ||
      byteLimit < 0
    ) {
      throw new Error("invalid native image store configuration");
    }
    this.#root = resolve(root);
    this.#byteLimit = byteLimit;
    const escapedRoot = this.#root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.#reference = new RegExp(
      `@"(${escapedRoot}/remote-claw-native-${UUID})/(\\d+)\\.(jpg|png|webp|gif)"`,
      "g",
    );
  }

  async prepare(
    images: readonly HostImage[],
    displayText: string,
    signal: AbortSignal,
  ): Promise<PreparedNativeImages> {
    checkAbort(signal);
    if (images.length === 0 || images.length > MAX_ATTACHMENT_IMAGES) {
      throw new Error("invalid native image group");
    }
    const labels = images.map((image) => `📎 ${safeAttachmentName(image.name)}`).join(", ");
    if (displayText !== labels && !displayText.startsWith(`${labels}\n`)) {
      throw new Error("invalid native image display text");
    }
    let urlBytes = 0;
    let decodedBytes = 0;
    const decoded = images.map((image) => {
      urlBytes += Buffer.byteLength(image.url, "utf8");
      const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]*)$/.exec(image.url);
      const mime = match?.[1];
      const data = match?.[2];
      if (
        urlBytes > MAX_ATTACHMENT_TOTAL_BYTES ||
        mime === undefined ||
        data === undefined ||
        data.length > MAX_ATTACHMENT_B64 ||
        !isLikelyBase64(data)
      ) {
        throw new Error("invalid native image input");
      }
      const bytes = Buffer.from(data, "base64");
      decodedBytes += bytes.byteLength;
      return { bytes, ext: extForMime(mime) };
    });
    if (this.#reservedBytes + decodedBytes > this.#byteLimit) {
      throw new Error("native image storage byte limit exceeded");
    }
    // Reserve synchronously before filesystem awaits so concurrent preparations cannot overbook.
    this.#reservedBytes += decodedBytes;
    const directory = join(this.#root, `remote-claw-native-${randomUUID()}`);
    const files: string[] = [];
    let createdDirectory = false;
    let discarded: Promise<void> | undefined;
    const discard = (): Promise<void> => {
      discarded ??= (async () => {
        for (const path of files) await unlink(path);
        if (createdDirectory) await rmdir(directory);
        this.#reservedBytes -= decodedBytes;
      })();
      return discarded;
    };
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(this.#root);
      if (
        !rootStat.isDirectory() ||
        rootStat.uid !== process.getuid?.() ||
        (rootStat.mode & 0o022) !== 0
      ) {
        throw new Error("native image upload root is unsafe");
      }
      checkAbort(signal);
      await mkdir(directory, { mode: 0o700 });
      createdDirectory = true;
      for (const [index, image] of decoded.entries()) {
        checkAbort(signal);
        const path = join(directory, `${index + 1}.${image.ext}`);
        const file = await open(path, "wx", 0o600);
        files.push(path);
        try {
          await file.writeFile(image.bytes);
        } finally {
          await file.close();
        }
      }
      checkAbort(signal);
      return { text: `${files.map((path) => `@"${path}"`).join(" ")}\n${displayText}`, discard };
    } catch (error) {
      await discard();
      throw error;
    }
  }

  /** Strip only our exact generated reference group; ordinary user/provider references stay intact. */
  displayText(nativeText: string): string {
    const newline = nativeText.indexOf("\n");
    if (newline < 0) return nativeText;
    const prefix = nativeText.slice(0, newline);
    const text = nativeText.slice(newline + 1);
    const references = [...prefix.matchAll(this.#reference)];
    const labels = (text.split("\n", 1)[0] ?? "").split(", ");
    if (
      references.length === 0 ||
      references.length > MAX_ATTACHMENT_IMAGES ||
      references.map((match) => match[0]).join(" ") !== prefix ||
      labels.length !== references.length ||
      labels.some((label) => {
        const name = label.startsWith("📎 ") ? label.slice(3) : "";
        return name === "" || safeAttachmentName(name) !== name;
      }) ||
      references.some(
        (match, index) => match[1] !== references[0]?.[1] || match[2] !== String(index + 1),
      )
    ) {
      return nativeText;
    }
    return text;
  }
}
