// Explicitly opted-in live acceptance for the frozen OpenCode M2 tuple.
//
// Ordinary test/CI runs skip this file without touching the network. Once opted in, the caller must
// supply one existing canonical native session. The suite attaches to that exact session and leaves
// its lifecycle to the OpenCode TUI: it never discovers, creates, selects, or deletes native sessions.
// It drives two bounded model-bearing turns: a deliberately long first turn that is interrupted while
// active, then a short follow-up that proves the same projection remains usable.

import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { deriveIdentity } from "@remote-claw/clawsec";
import { beforeAll, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { Session } from "../session.js";
import {
  DEFAULT_OPENCODE_URL,
  type HistoryMessage,
  isOpencodeSessionId,
  OpencodeClient,
  type OpencodeClientOptions,
  type OpencodeEvent,
  type OpencodeModel,
} from "./client.js";
import { DEFAULT_OPENCODE_MODEL, OpencodeDriver, opencodePartId } from "./driver.js";

const RUN_LIVE = process.env.RC_OPENCODE_E2E_RUN === "1";
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

interface PromptCall {
  sessionId: string;
  text: string;
  model: OpencodeModel;
  partId: string;
}

/** A real client with content-free observation counters around the two native mutations. */
class ObservedOpencodeClient extends OpencodeClient {
  readonly prompts: PromptCall[] = [];
  successfulAborts = 0;
  activeProbe: (() => boolean) | undefined;
  activeAtAbort = false;

  override async promptAsync(
    sessionId: string,
    args: { text: string; model: OpencodeModel; partId: string },
    signal?: AbortSignal,
  ): Promise<void> {
    this.prompts.push({ sessionId, ...args });
    await super.promptAsync(sessionId, args, signal);
  }

  override async abort(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.activeAtAbort = this.activeProbe?.() === true;
    await super.abort(sessionId, signal);
    this.successfulAborts += 1;
  }
}

interface NativeLifecycleEvent {
  eventType: "session.status" | "session.idle" | "session.error";
  status?: string;
}

/** A second, independent GET /event reader. It never consults the driver's workerStatus projection. */
class NativeLifecycleObserver {
  readonly events: NativeLifecycleEvent[] = [];
  connected = false;
  currentStatus: string | undefined;
  fault: unknown;

  readonly #abort = new AbortController();
  readonly #done: Promise<void>;

  constructor(client: OpencodeClient, sessionId: string) {
    this.#done = this.#observe(client, sessionId);
  }

  checkpoint(): number {
    this.throwIfFaulted();
    return this.events.length;
  }

  throwIfFaulted(): void {
    if (this.fault !== undefined) throw this.fault;
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await this.#done;
  }

  async #observe(client: OpencodeClient, sessionId: string): Promise<void> {
    try {
      for await (const event of client.events(sessionId, this.#abort.signal)) {
        if (event.type === "server.connected") {
          this.connected = true;
          continue;
        }
        const lifecycle = nativeLifecycleEvent(event);
        if (lifecycle === undefined) continue;
        this.events.push(lifecycle);
        if (lifecycle.status !== undefined) this.currentStatus = lifecycle.status;
        if (lifecycle.eventType === "session.idle") this.currentStatus = "idle";
      }
      if (!this.#abort.signal.aborted) {
        this.fault = new Error("independent OpenCode event stream ended");
      }
    } catch (error) {
      if (!this.#abort.signal.aborted) this.fault = error;
    }
  }
}

function nativeLifecycleEvent(event: OpencodeEvent): NativeLifecycleEvent | undefined {
  if (event.type === "session.status") {
    const status = event.properties.status?.type;
    if (typeof status !== "string" || status === "") return undefined;
    return { eventType: "session.status", status };
  }
  if (event.type === "session.idle") return { eventType: "session.idle", status: "idle" };
  if (event.type === "session.error") return { eventType: "session.error" };
  return undefined;
}

function requiredSessionId(): string {
  const value = process.env.RC_OPENCODE_E2E_SESSION;
  if (!isOpencodeSessionId(value)) {
    throw new Error(
      "RC_OPENCODE_E2E_SESSION is required and must be one existing canonical ses_* session",
    );
  }
  return value;
}

function clientOptions(): OpencodeClientOptions {
  // OpencodeClient applies the same strict explicit-port loopback-origin validator as the CLI. The
  // password is read without trimming so even leading/trailing whitespace remains credential data.
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  return {
    baseUrl: process.env.OPENCODE_URL ?? DEFAULT_OPENCODE_URL,
    username: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
    ...(password !== undefined ? { password } : {}),
  };
}

async function waitForValue<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const value = await read();
  if (value !== undefined) return value;
  throw new Error(`timed out waiting for ${label}`);
}

function nativeText(message: HistoryMessage): string {
  return message.parts
    .flatMap((part) => {
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("");
}

async function waitForNativeUser(
  client: OpencodeClient,
  sessionId: string,
  partId: string,
  exactText: string,
): Promise<HistoryMessage> {
  return waitForValue(
    async () => {
      const history = await client.getMessages(sessionId, AbortSignal.timeout(5_000));
      const matches = history.filter(
        (candidate) =>
          candidate.info.role === "user" && candidate.parts.some((part) => part.id === partId),
      );
      if (matches.length > 1) {
        throw new Error("the native history reused a browser correlation part");
      }
      const message = matches[0];
      if (message === undefined || nativeText(message) !== exactText) return undefined;
      const markers = message.parts.filter((part) => part.id === partId);
      if (markers.length !== 1) {
        throw new Error("the native user did not retain exactly one browser correlation part");
      }
      const marker = markers[0] as { type?: unknown; text?: unknown } | undefined;
      return marker?.type === "text" && marker.text === exactText ? message : undefined;
    },
    10_000,
    "the native-generated user with its exact browser part marker",
  );
}

async function waitForNativeAssistant(
  client: OpencodeClient,
  sessionId: string,
  userMessageId: string,
  exactText: string,
): Promise<HistoryMessage> {
  return waitForValue(
    async () => {
      const history = await client.getMessages(sessionId, AbortSignal.timeout(5_000));
      return history.find((message) => {
        if (
          message.info.role !== "assistant" ||
          message.info.parentID !== userMessageId ||
          message.info.time?.completed === undefined
        ) {
          return false;
        }
        const text = nativeText(message);
        return text.length > 0 && text === exactText;
      });
    },
    TURN_TIMEOUT_MS,
    "the exact completed native assistant bound to the follow-up user",
  );
}

async function waitForLifecycle(
  observer: NativeLifecycleObserver,
  start: number,
  predicate: (event: NativeLifecycleEvent) => boolean,
  timeoutMs: number,
  label: string,
): Promise<{ event: NativeLifecycleEvent; index: number }> {
  return waitForValue(
    () => {
      observer.throwIfFaulted();
      const relative = observer.events.slice(start).findIndex(predicate);
      if (relative < 0) return undefined;
      const index = start + relative;
      const event = observer.events[index];
      return event === undefined ? undefined : { event, index };
    },
    timeoutMs,
    label,
  );
}

describe.runIf(RUN_LIVE)(
  "OpenCode M2 live acceptance",
  { timeout: TURN_TIMEOUT_MS + 30_000 },
  () => {
    let client: ObservedOpencodeClient;
    let nativeSessionId: string;

    beforeAll(async () => {
      if (process.platform !== "linux" || process.arch !== "arm64") {
        throw new Error("OpenCode M2 live acceptance requires the frozen Linux arm64 tuple");
      }
      nativeSessionId = requiredSessionId();
      client = new ObservedOpencodeClient(clientOptions());
      await client.requireSupportedVersion(AbortSignal.timeout(10_000));
      const exact = await client.getSession(nativeSessionId, AbortSignal.timeout(10_000));
      if (exact.id !== nativeSessionId) {
        throw new Error("OpenCode returned a different session than the required exact attachment");
      }
    });

    it("observes exact browser coordinates, interrupts an active turn, then completes a later turn", async () => {
      const broker = new FakeBroker();
      let relaySession: Session | null = null;
      const abort = new AbortController();
      let run: Promise<number> | undefined;
      let observer: NativeLifecycleObserver | undefined;

      try {
        observer = new NativeLifecycleObserver(client, nativeSessionId);
        await waitForValue(
          () => {
            observer?.throwIfFaulted();
            return observer?.connected === true ? true : undefined;
          },
          10_000,
          "the independent native event stream",
        );

        const identity = await deriveIdentity(new TextEncoder().encode("opencode-m2-live"));
        const driver = new OpencodeDriver({
          harnessArgs: [],
          identity,
          brokerUrl: "http://broker.invalid",
          title: "remote-claw OpenCode M2 live acceptance",
          cwd: "/tmp",
          git: null,
          newClient: () => broker as unknown as BrokerClient,
          onSession: (session) => {
            relaySession = session;
          },
          extra: {
            client,
            sessionId: nativeSessionId,
            model: DEFAULT_OPENCODE_MODEL,
            mirrorPermissions: false,
          },
        });
        run = driver.run(abort.signal);

        await waitForValue(
          () => broker.posts.find((post) => post.recordKind === "session_announce"),
          10_000,
          "relay readiness",
        );
        if (relaySession === null) throw new Error("driver did not create its relay session");
        const session = relaySession as Session;
        client.activeProbe = () => observer?.currentStatus === "busy";

        const interruptLifecycleStart = observer.checkpoint();
        const interruptText =
          `remote-claw interrupt probe ${crypto.randomUUID()}: ` +
          "write the integers 1 through 1000, one per line, without calling tools";
        const interruptClientId = `live-interrupt-${crypto.randomUUID()}`;
        const interruptEvent = session.pushUserInput(interruptText, {
          clientMsgId: interruptClientId,
        });
        const interruptPartId = opencodePartId(interruptEvent.eventId);

        const interruptUser = await waitForNativeUser(
          client,
          nativeSessionId,
          interruptPartId,
          interruptText,
        );
        const interruptBusy = await waitForLifecycle(
          observer,
          interruptLifecycleStart,
          (event) => event.eventType === "session.status" && event.status === "busy",
          10_000,
          "an independent native busy event for the interrupt turn",
        );
        expect(
          observer.events
            .slice(interruptLifecycleStart, interruptBusy.index + 1)
            .some((event) => event.eventType === "session.error"),
        ).toBe(false);
        session.pushControlRequest("interrupt");
        await waitForValue(
          () => (client.successfulAborts === 1 ? true : undefined),
          10_000,
          "the native interrupt acknowledgement",
        );
        expect(client.activeAtAbort).toBe(true);
        expect(client.prompts[0]).toEqual({
          sessionId: nativeSessionId,
          text: interruptText,
          model: DEFAULT_OPENCODE_MODEL,
          partId: interruptPartId,
        });
        expect(interruptUser.parts).toContainEqual(
          expect.objectContaining({
            id: interruptPartId,
            messageID: interruptUser.info.id,
            type: "text",
            text: interruptText,
          }),
        );
        await waitForLifecycle(
          observer,
          interruptBusy.index + 1,
          (event) => event.eventType === "session.status" && event.status === "idle",
          10_000,
          "an independent native idle event after interrupt",
        );

        const expectedResponse = `M2_CONTINUATION_ACK_${crypto.randomUUID().replaceAll("-", "")}`;
        const continuationText =
          `remote-claw continuation probe ${crypto.randomUUID()}: ` +
          `reply with exactly ${expectedResponse} and nothing else. Do not call tools.`;
        const continuationClientId = `live-continuation-${crypto.randomUUID()}`;
        const continuationLifecycleStart = observer.checkpoint();
        const continuationEvent = session.pushUserInput(continuationText, {
          clientMsgId: continuationClientId,
        });
        const continuationPartId = opencodePartId(continuationEvent.eventId);

        const continuationUser = await waitForNativeUser(
          client,
          nativeSessionId,
          continuationPartId,
          continuationText,
        );
        const continuationBusy = await waitForLifecycle(
          observer,
          continuationLifecycleStart,
          (event) => event.eventType === "session.status" && event.status === "busy",
          10_000,
          "an independent native busy event for the continuation",
        );
        const assistant = await waitForNativeAssistant(
          client,
          nativeSessionId,
          continuationUser.info.id,
          expectedResponse,
        );
        const continuationIdle = await waitForLifecycle(
          observer,
          continuationBusy.index + 1,
          (event) => event.eventType === "session.status" && event.status === "idle",
          10_000,
          "an independent native idle event after the continuation",
        );
        expect(assistant.info.parentID).toBe(continuationUser.info.id);
        expect(nativeText(assistant)).toBe(expectedResponse);
        expect(
          observer.events
            .slice(continuationLifecycleStart, continuationIdle.index + 1)
            .some((event) => event.eventType === "session.error"),
        ).toBe(false);
        expect(client.prompts[1]).toEqual({
          sessionId: nativeSessionId,
          text: continuationText,
          model: DEFAULT_OPENCODE_MODEL,
          partId: continuationPartId,
        });

        const projectedUser = await waitForValue(
          () =>
            session
              .snapshotUpstream()
              .find(
                (event) =>
                  event.eventType === "user" && event.payload.uuid === continuationUser.info.id,
              ),
          10_000,
          "the canonical projected follow-up user message",
        );
        expect(projectedUser.payload).toMatchObject({
          uuid: continuationUser.info.id,
          client_msg_id: continuationClientId,
          local_prompt: true,
          message: { role: "user", content: continuationText },
        });
        await waitForValue(
          () =>
            session
              .snapshotUpstream()
              .find(
                (event) =>
                  event.eventType === "assistant" && event.payload.uuid === assistant.info.id,
              ),
          10_000,
          "the completed native assistant in the relay projection",
        );
        expect(broker.content.some((post) => post.recordKind === "assistant")).toBe(true);
      } finally {
        abort.abort();
        if (run !== undefined) await run;
        await observer?.close();
      }
    });
  },
);
