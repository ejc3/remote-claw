// Explicitly opted-in live compatibility checks for `opencode serve`.
//
// Ordinary test/CI runs skip this file without touching the network. Once opted in, an unreachable
// server is a failure, not a skip. The suite makes at most one model-bearing request: one real
// OpencodeDriver -> native server -> FakeBroker text round-trip. The other scenario is model-free and
// retains the native protocol fact that a 204 receipt is not delivery proof and a repeated caller
// message ID is not an idempotency key.

import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { deriveIdentity } from "@remote-claw/clawsec";
import { beforeAll, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { Session } from "../session.js";
import {
  DEFAULT_OPENCODE_URL,
  isOpencodeSessionId,
  OpencodeClient,
  type OpencodeModel,
} from "./client.js";
import { DEFAULT_OPENCODE_MODEL, OpencodeDriver } from "./driver.js";

const RUN_LIVE = process.env.RC_OPENCODE_E2E_RUN === "1";
const BASE_URL = (process.env.OPENCODE_URL ?? DEFAULT_OPENCODE_URL).replace(/\/+$/, "");
const TURN_TIMEOUT_MS = 120_000;

type BrokerPost = { recordKind: string; seq: number | null; text: string };

class FakeBroker {
  readonly posts: BrokerPost[] = [];

  get content(): BrokerPost[] {
    return this.posts.filter((post) => post.seq !== null);
  }

  async seqCursor(): Promise<{ maxSeq: number | null; durable: boolean }> {
    return { maxSeq: null, durable: false };
  }

  async maxSeq(): Promise<number | null> {
    return null;
  }

  async frameCountCursor(): Promise<{ frameCount: number | null; durable: boolean }> {
    return { frameCount: null, durable: false };
  }

  async frameCount(): Promise<number | null> {
    return null;
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    this.#record(header, body);
    return [{ ok: true }];
  }

  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    this.#record(header, body);
    return { ok: true };
  }

  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve();
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async openFrame(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  #record(header: FrameHeader, body: Uint8Array): void {
    this.posts.push({
      recordKind: header.recordKind,
      seq: header.seq,
      text: new TextDecoder().decode(body),
    });
  }
}

function selectedModel(): OpencodeModel {
  const raw = process.env.RC_OPENCODE_E2E_MODEL?.trim();
  if (!raw) return DEFAULT_OPENCODE_MODEL;
  const split = raw.indexOf("/");
  if (split <= 0 || split === raw.length - 1) {
    throw new Error("RC_OPENCODE_E2E_MODEL must be providerID/modelID");
  }
  return { providerID: raw.slice(0, split), modelID: raw.slice(split + 1) };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
}

async function deleteSession(sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined) return;
  try {
    await request(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch {
    // The explicit live assertions report server failures; cleanup remains best-effort.
  }
}

interface NativePart {
  id?: string;
  messageID?: string;
  text?: string;
  type?: string;
}

interface NativeMessage {
  info?: { id?: string; role?: string };
  parts?: NativePart[];
}

async function waitForMessageParts(
  sessionId: string,
  messageId: string,
  text: string,
  expectedCount: number,
): Promise<NativePart[]> {
  const deadline = Date.now() + 5_000;
  do {
    const response = await request(`/session/${encodeURIComponent(sessionId)}/message`);
    expect(response.ok).toBe(true);
    const messages = (await response.json()) as NativeMessage[];
    const parts = messages.find((message) => message.info?.id === messageId)?.parts;
    if (
      parts?.length === expectedCount &&
      parts.every(
        (part) => part.messageID === messageId && part.text === text && part.type === "text",
      )
    ) {
      return parts;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(
    `native history did not reach ${expectedCount} matching text part(s) for ${messageId}`,
  );
}

describe.runIf(RUN_LIVE)(
  "OpenCode live compatibility",
  { timeout: TURN_TIMEOUT_MS + 15_000 },
  () => {
    beforeAll(async () => {
      let response: Response;
      try {
        response = await request("/session");
      } catch (cause) {
        throw new Error(`opted-in OpenCode server is unreachable at ${BASE_URL}`, { cause });
      }
      if (!response.ok) {
        throw new Error(`opted-in OpenCode server returned HTTP ${response.status} at ${BASE_URL}`);
      }
    });

    it("retains marker correlation and proves same-ID 204 resend is not idempotent", async () => {
      const marker = `remote-claw-e2e-${crypto.randomUUID()}`;
      const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
      const text = `model-free-${crypto.randomUUID()}`;
      let sessionId: string | undefined;

      try {
        const createdResponse = await request("/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "remote-claw native protocol regression",
            metadata: { remoteClawCreationId: marker },
          }),
        });
        expect(createdResponse.status).toBe(200);
        const created = (await createdResponse.json()) as {
          id?: unknown;
          metadata?: { remoteClawCreationId?: unknown };
        };
        expect(isOpencodeSessionId(created.id)).toBe(true);
        if (!isOpencodeSessionId(created.id)) throw new Error("invalid native session id");
        sessionId = created.id;
        expect(created.metadata?.remoteClawCreationId).toBe(marker);

        const listedResponse = await request("/session");
        expect(listedResponse.ok).toBe(true);
        const listed = (await listedResponse.json()) as Array<{
          id?: unknown;
          metadata?: { remoteClawCreationId?: unknown };
        }>;
        expect(
          listed.filter((session) => session.metadata?.remoteClawCreationId === marker),
        ).toEqual([expect.objectContaining({ id: sessionId })]);

        const promptBody = JSON.stringify({
          messageID: messageId,
          noReply: true,
          parts: [{ type: "text", text }],
        });
        const send = async (): Promise<Response> =>
          request(`/session/${encodeURIComponent(sessionId as string)}/prompt_async`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: promptBody,
          });

        const firstReceipt = await send();
        expect(firstReceipt.status).toBe(204);
        expect((await firstReceipt.arrayBuffer()).byteLength).toBe(0);
        const firstParts = await waitForMessageParts(sessionId, messageId, text, 1);
        expect(firstParts[0]).toMatchObject({ messageID: messageId, text, type: "text" });

        const secondReceipt = await send();
        expect(secondReceipt.status).toBe(204);
        expect((await secondReceipt.arrayBuffer()).byteLength).toBe(0);
        const secondParts = await waitForMessageParts(sessionId, messageId, text, 2);
        expect(secondParts).toEqual([
          expect.objectContaining({ messageID: messageId, text, type: "text" }),
          expect.objectContaining({ messageID: messageId, text, type: "text" }),
        ]);
        expect(secondParts[0]?.id).not.toBe(secondParts[1]?.id);
      } finally {
        await deleteSession(sessionId);
      }
    });

    it("relays one real native text turn through OpencodeDriver", async () => {
      const client = new OpencodeClient({ baseUrl: BASE_URL });
      const broker = new FakeBroker();
      let nativeSessionId: string | undefined;
      let relaySession: Session | null = null;
      const abort = new AbortController();
      let run: Promise<number> | undefined;

      try {
        nativeSessionId = await client.createSession("remote-claw live smoke");
        const identity = await deriveIdentity(new TextEncoder().encode("opencode-live-smoke"));
        const driver = new OpencodeDriver({
          harnessArgs: [],
          identity,
          brokerUrl: "http://broker.invalid",
          title: "remote-claw live smoke",
          cwd: "/tmp",
          git: null,
          newClient: () => broker as unknown as BrokerClient,
          onSession: (session) => {
            relaySession = session;
          },
          extra: {
            client,
            sessionId: nativeSessionId,
            model: selectedModel(),
            mirrorPermissions: false,
          },
        });
        run = driver.run(abort.signal);

        expect(
          await waitFor(
            () => broker.posts.some((post) => post.recordKind === "session_announce"),
            10_000,
          ),
        ).toBe(true);
        if (relaySession === null) throw new Error("driver did not create its relay session");
        (relaySession as Session).pushUserInput("Reply with exactly: OK");

        expect(
          await waitFor(
            () => broker.content.some((post) => post.recordKind === "assistant"),
            TURN_TIMEOUT_MS,
          ),
        ).toBe(true);
        const assistants = broker.content.filter((post) => post.recordKind === "assistant");
        expect(assistants).toHaveLength(1);
        expect(assistants[0]?.text.length).toBeGreaterThan(0);
      } finally {
        abort.abort();
        if (run !== undefined) await run;
        await deleteSession(nativeSessionId);
      }
    });
  },
);
