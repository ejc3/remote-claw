import {
  deriveIdentity,
  encodeFrame,
  type FrameHeader,
  type Identity,
  seal,
  toHex,
  utf8,
  type WireFrame,
} from "@remote-claw/clawsec";

/** A deterministic test identity (distinct `fill` → distinct identity). */
export function testIdentity(fill = 7): Promise<Identity> {
  return deriveIdentity(new Uint8Array(32).fill(fill));
}

/** The `Authorization` header value the broker expects: Bearer <hex(auth_token)>. */
export function bearer(authToken: Uint8Array): string {
  return `Bearer ${toHex(authToken)}`;
}

/** Seal `plaintext` under `planeKey` for `header` and return the JSON wire frame a client posts. */
export async function wireFrame(
  planeKey: Uint8Array,
  header: FrameHeader,
  plaintext: Uint8Array,
): Promise<WireFrame> {
  return encodeFrame(await seal(planeKey, header, plaintext));
}

/** Build a frame header with sensible defaults for a bus/session frame. */
export function header(identity: Identity, extra: Partial<FrameHeader> = {}): FrameHeader {
  return {
    v: 1,
    identityId: identity.identityId,
    sessionId: "sess-1",
    dir: "out",
    recordKind: "session_announce",
    seq: null,
    msgId: "m1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...extra,
  };
}

/** A meta-plane announce frame (the bus payload): JSON plaintext sealed under K_meta. */
export async function announceFrame(
  identity: Identity,
  body: Record<string, unknown>,
  extra: Partial<FrameHeader> = {},
): Promise<WireFrame> {
  return wireFrame(identity.kMeta, header(identity, extra), utf8(JSON.stringify(body)));
}

const RACE_MS = 8000;

/** Read up to `max` SSE `data:` payloads from a Response body, then cancel. Time-bounded. */
export async function readSseData(res: Response, max: number): Promise<unknown[]> {
  if (res.body === null) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out: unknown[] = [];
  let buf = "";
  const deadline = Date.now() + RACE_MS;
  try {
    while (out.length < max) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timeout: true }>((r) => {
        timer = setTimeout(() => r({ timeout: true }), remaining);
      });
      let res2: { timeout: true } | ReadableStreamReadResult<Uint8Array>;
      try {
        res2 = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if ("timeout" in res2) break;
      if (res2.done) break;
      buf += decoder.decode(res2.value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const record = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of record.split("\n")) {
          if (line.startsWith("data: ")) out.push(JSON.parse(line.slice(6)));
        }
        idx = buf.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return out;
}
