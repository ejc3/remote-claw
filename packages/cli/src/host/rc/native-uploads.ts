import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { mkdir, open, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { MAX_USER_CONTENT_CHARS } from "./anthropic/client.js";
import {
  boundedImagePreviews,
  extForMime,
  isLikelyBase64,
  MAX_ATTACHMENT_B64,
  MAX_ATTACHMENT_IMAGES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  safeAttachmentName,
} from "./relay.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const PREVIEW_BYTES = 1024 * 1024;
const PREVIEW_TOTAL_BYTES = 8 * PREVIEW_BYTES;
const PREVIEW_COUNT = 8;
const IMAGE_MIMES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export interface NativeUpload {
  name: string;
  mime: string;
  data: string;
}

/** One projection's retained preview allowance, independent of native attachment input. Call only
 * after canonical duplicate admission; omitted previews never remove the message's file labels. */
export class NativePreviewBudget {
  #remaining: number;

  constructor(byteLimit = 32 * 1024 * 1024) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 0)
      throw new TypeError("native preview byte limit must be a non-negative safe integer");
    this.#remaining = byteLimit;
  }

  accept(images: readonly NativeUpload[]): NativeUpload[] {
    if (this.#remaining === 0) return [];
    return boundedImagePreviews(images).filter((image) => {
      // boundedImagePreviews has already validated canonical base64 and per-image size.
      const bytes = Buffer.byteLength(image.data, "base64");
      if (bytes > this.#remaining) return false;
      this.#remaining -= bytes;
      return true;
    });
  }
}

export interface PreparedNativeUploads {
  text: string;
  /** Only discard when no native submission was attempted. Ambiguous sends retain their files. */
  discard(): Promise<void>;
}

function privateOwned(stat: Stats, directory: boolean): boolean {
  return (
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o777) === (directory ? 0o700 : 0o600) &&
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
  );
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("native upload preparation aborted");
}

function labelsFrom(text: string): string[] | null {
  const labels = (text.split("\n", 1)[0] ?? "").split(", ");
  if (labels.length === 0 || labels.length > MAX_ATTACHMENT_IMAGES) return null;
  const names = labels.map((label) => (label.startsWith("📎 ") ? label.slice(3) : ""));
  return names.every((name) => name !== "" && safeAttachmentName(name) === name) ? names : null;
}

function uploadExtension(upload: NativeUpload): string {
  const image = extForMime(upload.mime);
  if (image !== "") return image;
  const suffix = extname(upload.name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(suffix) ? suffix : "bin";
}

/** Host-owned files, not permission grants. Native harnesses retain their normal read policy.
 * Files deliberately survive companion exit; callers discard only never-submitted groups. Linux
 * /proc/self/fd anchors operations to validated directories without following replaceable parents. */
export class NativeUploadStore {
  readonly #root: string;
  readonly #byteLimit: number;
  readonly #reference: RegExp;
  #reservedBytes = 0;

  constructor(root = join(homedir(), ".remote-claw-uploads"), byteLimit = 256 * 1024 * 1024) {
    if (
      !isAbsolute(root) ||
      [...root].some(
        (char) =>
          char === '"' ||
          char === "\\" ||
          char.charCodeAt(0) < 32 ||
          (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
      ) ||
      !Number.isSafeInteger(byteLimit) ||
      byteLimit < 0
    )
      throw new Error("invalid native upload store configuration");
    this.#root = resolve(root);
    this.#byteLimit = byteLimit;
    const escaped = this.#root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.#reference = new RegExp(
      `@"(${escaped}/(remote-claw-(?:upload|native)-${UUID}))/(\\d+)\\.([a-z0-9]{1,12})"`,
      "g",
    );
  }

  async prepare(
    uploads: readonly NativeUpload[],
    displayText: string,
    signal: AbortSignal,
  ): Promise<PreparedNativeUploads> {
    checkAbort(signal);
    if (uploads.length === 0 || uploads.length > MAX_ATTACHMENT_IMAGES)
      throw new Error("invalid native upload group");
    const names = labelsFrom(displayText);
    if (names === null || names.length < uploads.length)
      throw new Error("invalid native upload display text");
    let encodedBytes = Buffer.byteLength(displayText);
    let decodedBytes = 0;
    const decoded = uploads.map((upload) => {
      if (
        typeof upload.name !== "string" ||
        upload.name === "" ||
        safeAttachmentName(upload.name) !== upload.name ||
        !names.includes(upload.name) ||
        typeof upload.mime !== "string" ||
        upload.mime.length > 127 ||
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(upload.mime) ||
        typeof upload.data !== "string" ||
        upload.data.length > MAX_ATTACHMENT_B64 ||
        (!(upload.data === "" && extForMime(upload.mime) === "") && !isLikelyBase64(upload.data))
      )
        throw new Error("invalid native upload input");
      encodedBytes += Buffer.byteLength(upload.data) + upload.name.length + upload.mime.length;
      if (encodedBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error("invalid native upload input");
      const bytes = Buffer.from(upload.data, "base64");
      decodedBytes += bytes.length;
      return { bytes, ext: uploadExtension(upload) };
    });
    const group = `remote-claw-upload-${randomUUID()}`;
    const directory = join(this.#root, group);
    const filenames = decoded.map((upload, index) => `${index + 1}.${upload.ext}`);
    const text = `${filenames.map((name) => `@"${join(directory, name)}"`).join(" ")}\n${displayText}`;
    if (text.length > MAX_USER_CONTENT_CHARS)
      throw new Error("native upload message exceeds native text limit");
    if (this.#reservedBytes + decodedBytes > this.#byteLimit)
      throw new Error("native upload storage byte limit exceeded");
    // Reserve before awaits, so concurrent groups cannot overbook this companion's byte budget.
    this.#reservedBytes += decodedBytes;
    const files: string[] = [];
    let createdDirectory = false;
    let discarded: Promise<void> | undefined;
    const discard = (): Promise<void> => {
      discarded ??= (async () => {
        for (const path of files) await unlink(path);
        // A collision can leave unrelated data in the fresh directory. Never delete it, but do
        // refund our bytes once all files we actually created have been removed.
        this.#reservedBytes -= decodedBytes;
        if (createdDirectory) await rmdir(directory);
      })();
      return discarded;
    };
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const root = await open(this.#root, DIRECTORY_FLAGS);
      try {
        if (!privateOwned(await root.stat(), true)) throw new Error("native upload root is unsafe");
        checkAbort(signal);
        const anchoredDirectory = `/proc/self/fd/${root.fd}/${group}`;
        await mkdir(anchoredDirectory, { mode: 0o700 });
        createdDirectory = true;
        const folder = await open(anchoredDirectory, DIRECTORY_FLAGS);
        try {
          if (!privateOwned(await folder.stat(), true))
            throw new Error("native upload directory is unsafe");
          for (const [index, upload] of decoded.entries()) {
            checkAbort(signal);
            const filename = filenames[index];
            if (filename === undefined) throw new Error("missing prepared upload path");
            const file = await open(
              `/proc/self/fd/${folder.fd}/${filename}`,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            files.push(join(directory, filename));
            try {
              if (!privateOwned(await file.stat(), false))
                throw new Error("native upload file is unsafe");
              await file.writeFile(upload.bytes);
            } finally {
              await file.close();
            }
          }
          checkAbort(signal);
        } finally {
          await folder.close();
        }
      } finally {
        await root.close();
      }
      return { text, discard };
    } catch (error) {
      await discard();
      throw error;
    }
  }

  /** Normalize only exact generated prefixes. Preview failure never hides labels or stops capture.
   * Reads are synchronous to preserve native item order, capped at eight 1 MiB images per group. */
  display(nativeText: string): { text: string; images: NativeUpload[] } {
    const newline = nativeText.indexOf("\n");
    if (newline < 0) return { text: nativeText, images: [] };
    const prefix = nativeText.slice(0, newline);
    const text = nativeText.slice(newline + 1);
    const references = [...prefix.matchAll(this.#reference)];
    const names = labelsFrom(text);
    if (
      names === null ||
      references.length === 0 ||
      references.length > names.length ||
      references.map((match) => match[0]).join(" ") !== prefix ||
      references.some(
        (match, index) =>
          match[1] !== references[0]?.[1] ||
          match[3] !== String(index + 1) ||
          (match[2]?.startsWith("remote-claw-native-") === true &&
            IMAGE_MIMES[match[4] ?? ""] === undefined),
      )
    )
      return { text: nativeText, images: [] };
    const result: { text: string; images: NativeUpload[] } = { text, images: [] };
    // Codex can mix inline images with host-file refs. Without a manifest there is no exact
    // name-to-reference mapping for unequal groups, so retain labels without guessing previews.
    if (names.length !== references.length) return result;
    let root: number | undefined;
    let folder: number | undefined;
    try {
      root = openSync(this.#root, DIRECTORY_FLAGS);
      if (!privateOwned(fstatSync(root), true)) return result;
      folder = openSync(`/proc/self/fd/${root}/${references[0]?.[2]}`, DIRECTORY_FLAGS);
      if (!privateOwned(fstatSync(folder), true)) return result;
      let total = 0;
      for (const [index, match] of references.entries()) {
        const ext = match[4] ?? "";
        const mime = IMAGE_MIMES[ext];
        const name = names[index];
        if (mime === undefined || name === undefined || result.images.length >= PREVIEW_COUNT)
          continue;
        let file: number | undefined;
        try {
          file = openSync(
            `/proc/self/fd/${folder}/${match[3]}.${ext}`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          const stat = fstatSync(file);
          if (
            !privateOwned(stat, false) ||
            stat.size === 0 ||
            stat.size > PREVIEW_BYTES ||
            total + stat.size > PREVIEW_TOTAL_BYTES
          )
            continue;
          const bytes = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < bytes.length) {
            const read = readSync(file, bytes, offset, bytes.length - offset, offset);
            if (read === 0) break;
            offset += read;
          }
          if (offset !== bytes.length || fstatSync(file).size !== bytes.length) continue;
          total += bytes.length;
          result.images.push({ name, mime, data: bytes.toString("base64") });
        } catch {
          // Missing, changed, or unsafe image: its canonical label remains visible.
        } finally {
          if (file !== undefined) closeSync(file);
        }
      }
    } catch {
      // A historical group's private files may no longer be available.
    } finally {
      if (folder !== undefined) closeSync(folder);
      if (root !== undefined) closeSync(root);
    }
    return result;
  }
}
