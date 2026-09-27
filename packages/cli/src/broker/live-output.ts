import type { FrameHeader } from "@remote-claw/clawsec";

export const LIVE_OUTPUT_KIND = "assistant_preview";
export const LIVE_OUTPUT_PLAINTEXT_LIMIT = 16 * 1024;
export const LIVE_OUTPUT_WIRE_LIMIT = 32 * 1024;
export const LIVE_OUTPUT_TTL_MS = 30_000;

/** A cap enforced before buffering either request or broker-controlled response bodies. */
export async function readLiveBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > LIVE_OUTPUT_WIRE_LIMIT) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    reader.releaseLock();
  }
}

export interface LiveCoordinate {
  startedAt: number;
  incarnation: string;
  revision: number;
}
export interface LiveItem {
  finalMsgId: string;
  text: string;
  truncated: boolean;
}
export interface LiveOutput extends LiveCoordinate {
  v: 1;
  sentAt: number;
  item: LiveItem | null;
}
const integer = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function liveOutputId(c: LiveCoordinate): string {
  return `preview.v1.${c.startedAt}.${c.incarnation}.${c.revision}`;
}

/** The ordering coordinate is in existing AAD, not unauthenticated JSON beside the ciphertext. */
export function parseLiveCoordinate(id: string): LiveCoordinate | null {
  const match = /^preview\.v1\.(0|[1-9][0-9]*)\.([A-Za-z0-9-]{1,64})\.(0|[1-9][0-9]*)$/.exec(id);
  if (!match) return null;
  const startedAt = Number(match[1]);
  const revision = Number(match[3]);
  if (!integer(startedAt) || !integer(revision)) return null;
  return { startedAt, incarnation: match[2] as string, revision };
}

export function compareLiveCoordinates(a: LiveCoordinate, b: LiveCoordinate): number {
  return (
    a.startedAt - b.startedAt ||
    (a.incarnation === b.incarnation
      ? a.revision - b.revision
      : a.incarnation > b.incarnation
        ? 1
        : -1)
  );
}

export function isLiveHeader(h: FrameHeader): boolean {
  return (
    h.v === 1 &&
    h.recordKind === LIVE_OUTPUT_KIND &&
    h.dir === "out" &&
    h.seq === null &&
    h.part === 0 &&
    h.parts === 1 &&
    h.keyEpoch === 0 &&
    h.clientMsgId === undefined &&
    h.sessionId !== "" &&
    parseLiveCoordinate(h.msgId) !== null
  );
}

/** Bound serialized bytes (including JSON escaping), not UTF-16 characters. */
export function boundLiveText(text: string): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const budget = LIVE_OUTPUT_PLAINTEXT_LIMIT - 1024;
  if (encoder.encode(JSON.stringify(text)).length <= budget) return { text, truncated: false };
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(JSON.stringify(text.slice(0, mid))).length <= budget) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text.charAt(low - 1))) low--;
  return { text: text.slice(0, low), truncated: true };
}

export function parseLiveOutput(text: string, msgId: string): LiveOutput | null {
  if (new TextEncoder().encode(text).length > LIVE_OUTPUT_PLAINTEXT_LIMIT) return null;
  const coordinate = parseLiveCoordinate(msgId);
  if (!coordinate) return null;
  try {
    const value = JSON.parse(text) as LiveOutput;
    if (
      value?.v !== 1 ||
      !integer(value.sentAt) ||
      value.startedAt !== coordinate.startedAt ||
      value.incarnation !== coordinate.incarnation ||
      value.revision !== coordinate.revision
    )
      return null;
    const item = value.item;
    if (
      item !== null &&
      (!item ||
        !/^native-text-[a-f0-9]{64}$/.test(item.finalMsgId) ||
        typeof item.text !== "string" ||
        typeof item.truncated !== "boolean")
    )
      return null;
    return {
      ...coordinate,
      v: 1,
      sentAt: value.sentAt,
      item:
        item === null
          ? null
          : { finalMsgId: item.finalMsgId, text: item.text, truncated: item.truncated },
    };
  } catch {
    return null;
  }
}
