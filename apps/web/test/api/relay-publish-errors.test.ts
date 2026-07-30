import type { WireFrame } from "@remote-claw/clawsec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../app/api/relay/route";
import {
  type BrokerBackend,
  PublishConflictError,
  type PublishResult,
  type RelayPayload,
} from "../../lib/broker/backend";
import { brokerCache } from "../../lib/broker/broker-cache";
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
  const frame = await announceFrame(identity, { session_id: "error-classification" });
  return new Request("https://app.test/api/relay?backend=vercel", {
    method: "POST",
    headers: {
      authorization: bearer(identity.authToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(frame),
  });
}

describe("POST /api/relay publish error classification", () => {
  let previous: BrokerBackend | undefined;

  beforeEach(() => {
    previous = brokerCache().get("vercel");
  });

  afterEach(() => {
    if (previous === undefined) brokerCache().delete("vercel");
    else brokerCache().set("vercel", previous);
  });

  it("maps a retryable publish conflict to 409", async () => {
    brokerCache().set("vercel", new FailingBackend(new PublishConflictError("hook disappeared")));

    const response = await POST(await relayRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "hook disappeared" });
  });

  it("rethrows an unrelated publish failure for the framework's 500 path", async () => {
    const failure = new Error("workflow queue unavailable");
    brokerCache().set("vercel", new FailingBackend(failure));

    await expect(POST(await relayRequest())).rejects.toBe(failure);
  });
});
