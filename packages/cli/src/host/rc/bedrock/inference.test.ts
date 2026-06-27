import { describe, expect, it } from "vitest";
import type { BedrockAuth } from "./creds.js";
import { BedrockInference, type Responder } from "./inference.js";

class MockRes implements Responder {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  #ended = false;
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  // `backpressure` makes write return false and fire its flush callback on a microtask — exercising the
  // handler's await-until-flushed path the way a full socket buffer would.
  backpressure = false;
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (this.backpressure) {
      queueMicrotask(() => cb?.());
      return false;
    }
    cb?.();
    return true;
  }
  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) this.write(chunk);
    this.#ended = true;
  }
  get writableEnded(): boolean {
    return this.#ended;
  }
  body(): string {
    return this.chunks.join("");
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records the call and returns a canned Response. */
function recordingFetch(response: Response): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const bearerAuth = async (): Promise<BedrockAuth> => ({ kind: "bearer", token: "btok" });
const sigv4Auth = async (): Promise<BedrockAuth> => ({
  kind: "sigv4",
  credentials: { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "stok" },
});

const SSE =
  'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

describe("BedrockInference.serve", () => {
  it("translates the body, bearer-auths, calls mantle, streams the SSE back", async () => {
    const { fetchFn, calls } = recordingFetch(
      new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const inf = new BedrockInference({ region: "us-east-1", fetchFn, resolveAuth: bearerAuth });
    const res = new MockRes();
    await inf.serve(
      "/v1/messages",
      { "anthropic-beta": "interleaved-thinking-2025-05-14,context-1m-2025-08-07" },
      Buffer.from(JSON.stringify({ model: "claude-opus-4-8[1m]", messages: [], max_tokens: 8 })),
      res,
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer btok");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14"); // unsupported beta dropped
    const sentBody = JSON.parse(String(call?.init.body));
    expect(sentBody.model).toBe("anthropic.claude-opus-4-8");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body()).toBe(SSE);
    expect(res.writableEnded).toBe(true);
  });

  it("streams the full SSE through under backpressure (awaits each flush)", async () => {
    const { fetchFn } = recordingFetch(
      new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const inf = new BedrockInference({ region: "us-east-1", fetchFn, resolveAuth: bearerAuth });
    const res = new MockRes();
    res.backpressure = true; // every write returns false + flushes on a microtask
    await inf.serve("/v1/messages", {}, Buffer.from(JSON.stringify({ model: "x" })), res);
    expect(res.body()).toBe(SSE);
    expect(res.writableEnded).toBe(true);
  });

  it("uses SigV4 (Authorization AWS4-HMAC-SHA256) for credential auth", async () => {
    const { fetchFn, calls } = recordingFetch(new Response(SSE, { status: 200 }));
    const inf = new BedrockInference({ region: "us-west-2", fetchFn, resolveAuth: sigv4Auth });
    await inf.serve(
      "/v1/messages",
      {},
      Buffer.from(JSON.stringify({ model: "x", messages: [] })),
      new MockRes(),
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=id\//);
    expect(headers["x-amz-security-token"]).toBe("stok");
  });

  it("routes count_tokens to the mantle count_tokens path", async () => {
    const { fetchFn, calls } = recordingFetch(new Response('{"input_tokens":5}', { status: 200 }));
    const inf = new BedrockInference({ region: "us-east-1", fetchFn, resolveAuth: bearerAuth });
    await inf.serve(
      "/v1/messages/count_tokens",
      {},
      Buffer.from(JSON.stringify({ model: "x" })),
      new MockRes(),
    );
    expect(calls[0]?.url).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages/count_tokens",
    );
  });

  it("forwards a non-2xx mantle response verbatim (e.g. permission_error)", async () => {
    const err = JSON.stringify({
      type: "error",
      error: { type: "permission_error", message: "no" },
    });
    const { fetchFn } = recordingFetch(new Response(err, { status: 403 }));
    const inf = new BedrockInference({ fetchFn, resolveAuth: bearerAuth });
    const res = new MockRes();
    await inf.serve("/v1/messages", {}, Buffer.from(JSON.stringify({ model: "x" })), res);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body()).error.type).toBe("permission_error");
  });

  it("emits an Anthropic-format error when the fetch throws", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const inf = new BedrockInference({ fetchFn, resolveAuth: bearerAuth });
    const res = new MockRes();
    await inf.serve("/v1/messages", {}, Buffer.from(JSON.stringify({ model: "x" })), res);
    expect(res.status).toBe(502);
    const j = JSON.parse(res.body());
    expect(j.type).toBe("error");
    expect(j.error.message).toContain("network down");
  });
});
