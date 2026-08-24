import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WireFrame } from "@remote-claw/clawsec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../app/api/relay/route";
import {
  type BrokerBackend,
  PublishCollisionError,
  PublishConflictError,
  type PublishResult,
  type RelayPayload,
} from "../../lib/broker/backend";
import { brokerCache } from "../../lib/broker/broker-cache";
import {
  ChannelStorageLossError,
  FileDbLocator,
  SqliteMultiBackend,
} from "../../lib/broker/sqlite-multi";
import { channelToken } from "../../lib/channel";
import { announceFrame, bearer, uniqueIdentity } from "../helpers";

class FailingBackend implements BrokerBackend {
  constructor(readonly failure: unknown) {}

  async publish(_token: string, _payload: RelayPayload): Promise<PublishResult> {
    throw this.failure;
  }

  async subscribe(_token: string, _startIndex?: number): Promise<ReadableStream<WireFrame> | null> {
    return null;
  }
}

async function relayRequest(): Promise<Request> {
  const identity = await uniqueIdentity();
  return relayRequestFor(identity);
}

async function relayRequestFor(
  identity: Awaited<ReturnType<typeof uniqueIdentity>>,
  msgId = "m1",
): Promise<Request> {
  const frame = await announceFrame(identity, { session_id: "error-classification" });
  return new Request("https://app.test/api/relay?backend=vercel", {
    method: "POST",
    headers: {
      authorization: bearer(identity.authToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(msgId === "m1" ? frame : { ...frame, msg_id: msgId }),
  });
}

describe("POST /api/relay publish error classification", () => {
  let previous: BrokerBackend | undefined;
  const dirs: string[] = [];

  beforeEach(() => {
    previous = brokerCache().get("vercel");
  });

  afterEach(() => {
    if (previous === undefined) brokerCache().delete("vercel");
    else brokerCache().set("vercel", previous);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("maps permanent storage loss to an exact content-free 410 disposition", async () => {
    brokerCache().set("vercel", new FailingBackend(new ChannelStorageLossError()));

    const response = await POST(await relayRequest());

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      ok: false,
      code: "channel_storage_lost",
      error: "permanent channel storage loss",
    });
  });

  it("does not reinitialize a deleted known identity bus while its catalog and session store remain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-relay-bus-loss-"));
    dirs.push(dir);
    const locator = new FileDbLocator(dir);
    const backend = new SqliteMultiBackend(locator);
    brokerCache().set("vercel", backend);
    const identity = await uniqueIdentity();
    const busToken = channelToken(identity.identityId, null);
    const sessionToken = channelToken(identity.identityId, "still-live-session");
    const durableFrame = await announceFrame(
      identity,
      { session_id: "still-live-session" },
      { sessionId: "still-live-session", recordKind: "assistant", seq: 0, msgId: "session-0" },
    );
    await backend.publish(sessionToken, durableFrame);
    await expect(POST(await relayRequestFor(identity))).resolves.toMatchObject({ status: 200 });
    expect(await locator.exists(busToken)).toBe(true);
    expect(await locator.exists(sessionToken)).toBe(true);

    await locator.dropStored?.(locator.idFor(busToken));
    const response = await POST(await relayRequestFor(identity, "m2"));

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      ok: false,
      code: "channel_storage_lost",
      error: "permanent channel storage loss",
    });
    // Local libSQL may materialize an empty path while issuing the query that discovers the unlinked
    // cached database. It must remain an invalid replacement, never a fresh logical channel.
    await expect(backend.frameCount(busToken)).rejects.toBeInstanceOf(ChannelStorageLossError);
    await expect(POST(await relayRequestFor(identity, "m3"))).resolves.toMatchObject({
      status: 410,
    });
    expect(await locator.exists(sessionToken)).toBe(true);
    expect(await backend.frameCount(sessionToken)).toBe(1);
  });

  it("maps a retryable publish conflict to 409", async () => {
    brokerCache().set("vercel", new FailingBackend(new PublishConflictError("hook disappeared")));

    const response = await POST(await relayRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "hook disappeared" });
  });

  it("maps a changed durable-coordinate replay to hard 422, never retryable 409", async () => {
    brokerCache().set("vercel", new FailingBackend(new PublishCollisionError()));

    const response = await POST(await relayRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "publish coordinate already contains different frame bytes",
    });
  });

  it("rethrows an unrelated publish failure for the framework's 500 path", async () => {
    const failure = new Error("workflow queue unavailable");
    brokerCache().set("vercel", new FailingBackend(failure));

    await expect(POST(await relayRequest())).rejects.toBe(failure);
  });
});
