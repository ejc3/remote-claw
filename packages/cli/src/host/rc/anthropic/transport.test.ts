import { describe, expect, it, vi } from "vitest";
import { ClaudeOAuthCredentialError } from "./credentials.js";
import { AnthropicRcError } from "./errors.js";
import {
  ANTHROPIC_RC_ORIGIN,
  ANTHROPIC_VERSION,
  OAuthAnthropicRcTransport,
  type RcOAuthAccessTokenOptions,
  type RcOAuthProvider,
} from "./transport.js";

class ScriptedOAuth implements RcOAuthProvider {
  readonly calls: RcOAuthAccessTokenOptions[] = [];

  constructor(readonly tokens: string[]) {}

  async accessToken(options: RcOAuthAccessTokenOptions): Promise<string> {
    this.calls.push(options);
    const token = this.tokens.shift();
    if (token === undefined) throw new Error("unexpected token request");
    return token;
  }
}

describe("OAuthAnthropicRcTransport", () => {
  it("sends the bearer only to the fixed production origin with the pinned API version", async () => {
    const oauth = new ScriptedOAuth(["oauth-secret"]);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new OAuthAnthropicRcTransport({ oauth, fetchFn });

    await transport.request({
      operation: "history",
      method: "GET",
      path: "/v1/code/sessions/cse_1/events?sort_order=asc",
      accept: "application/json",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${ANTHROPIC_RC_ORIGIN}/v1/code/sessions/cse_1/events?sort_order=asc`,
    );
    expect(calls[0]?.init.redirect).toBe("error");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-secret");
    expect(headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBeNull();
    expect(oauth.calls).toEqual([{ forceRefresh: false }]);
  });

  it("retries the exact POST once after 401 only when native Claude rotated the bearer", async () => {
    const oauth = new ScriptedOAuth(["old-token", "new-token"]);
    const bodies: Array<string | undefined> = [];
    const auth: Array<string | null> = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : undefined);
      auth.push(new Headers(init?.headers).get("authorization"));
      return new Response("{}", { status: auth.length === 1 ? 401 : 200 });
    }) as unknown as typeof fetch;
    const transport = new OAuthAnthropicRcTransport({ oauth, fetchFn });
    const body = '{"events":[{"payload":{"uuid":"stable"}}]}';

    const response = await transport.request({
      operation: "postEvent",
      method: "POST",
      path: "/v1/code/sessions/cse_1/events",
      accept: "application/json",
      body,
    });

    expect(response.status).toBe(200);
    expect(bodies).toEqual([body, body]);
    expect(auth).toEqual(["Bearer old-token", "Bearer new-token"]);
    expect(oauth.calls).toEqual([
      { forceRefresh: false },
      { forceRefresh: true, rejectedAccessToken: "old-token" },
    ]);
  });

  it("does not replay a write because an injected fetch Response monkey-patched its status", async () => {
    const oauth = new ScriptedOAuth(["only-token"]);
    const response = new Response("{}", { status: 200 });
    Object.defineProperty(response, "status", {
      configurable: true,
      value: 401,
    });
    const fetchFn = vi.fn(async () => response) as unknown as typeof fetch;
    const transport = new OAuthAnthropicRcTransport({ oauth, fetchFn });

    await expect(
      transport.request({
        operation: "postEvent",
        method: "POST",
        path: "/v1/code/sessions/cse_1/events",
        accept: "application/json",
        body: '{"events":[]}',
      }),
    ).resolves.toBe(response);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(oauth.calls).toEqual([{ forceRefresh: false }]);
  });

  it("does not wait for a rejected Response body cleanup before a rotated-token retry", async () => {
    const oauth = new ScriptedOAuth(["old-token", "new-token"]);
    let cancelStarted: () => void = () => undefined;
    const cancelling = new Promise<void>((resolve) => {
      cancelStarted = resolve;
    });
    const rejected = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelStarted();
          return new Promise<void>(() => undefined);
        },
      }),
      { status: 401 },
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const transport = new OAuthAnthropicRcTransport({ oauth, fetchFn });

    await expect(
      transport.request({
        operation: "postEvent",
        method: "POST",
        path: "/v1/code/sessions/cse_1/events",
        accept: "application/json",
        body: '{"events":[]}',
      }),
    ).resolves.toMatchObject({ status: 200 });
    await cancelling;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("uses the branded 401 cleanup method instead of hostile own promise accessors", async () => {
    const oauth = new ScriptedOAuth(["old-token", "new-token"]);
    const rejected = new Response("private-401-body-canary", { status: 401 });
    if (rejected.body === null) throw new Error("missing test body");
    let ownCancelCalls = 0;
    Object.defineProperty(rejected.body, "cancel", {
      value: () => {
        ownCancelCalls += 1;
        const cleanup = Promise.reject(new Error("private-401-cleanup-rejection-canary"));
        Object.defineProperties(cleanup, {
          catch: {
            configurable: true,
            get() {
              throw new Error("private-401-cleanup-catch-canary");
            },
          },
          constructor: {
            configurable: true,
            get() {
              throw new Error("private-401-cleanup-constructor-canary");
            },
          },
        });
        return cleanup;
      },
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const transport = new OAuthAnthropicRcTransport({ oauth, fetchFn });

    await expect(
      transport.request({
        operation: "postEvent",
        method: "POST",
        path: "/v1/code/sessions/cse_1/events",
        accept: "application/json",
        body: '{"events":[]}',
      }),
    ).resolves.toMatchObject({ status: 200 });
    await Promise.resolve();
    expect(ownCancelCalls).toBe(0);
  });

  it("does not replay a 401 request when the provider still returns the rejected bearer", async () => {
    const oauth = new ScriptedOAuth(["same-token", "same-token"]);
    const fetchFn = vi.fn(
      async () => new Response("secret response body", { status: 401 }),
    ) as unknown as typeof fetch;
    const transport = new OAuthAnthropicRcTransport({ oauth, fetchFn });

    const response = await transport.request({
      operation: "postEvent",
      method: "POST",
      path: "/v1/code/sessions/cse_1/events",
      accept: "application/json",
      body: '{"prompt":"private"}',
    });

    expect(response.status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never retries an ambiguous network failure and does not retain its secret-bearing error", async () => {
    const oauth = new ScriptedOAuth(["oauth-canary"]);
    const fetchFn = vi.fn(async () => {
      throw new Error("network failed with oauth-canary and private-prompt");
    }) as unknown as typeof fetch;
    const transport = new OAuthAnthropicRcTransport({ oauth, fetchFn });

    const failure = transport.request({
      operation: "postEvent",
      method: "POST",
      path: "/v1/code/sessions/cse_1/events",
      accept: "application/json",
      body: '{"prompt":"private-prompt"}',
    });

    await expect(failure).rejects.toMatchObject({
      kind: "network",
      operation: "postEvent",
      retryable: false,
      outcomeUnknown: true,
    });
    await expect(failure).rejects.not.toThrow(/oauth-canary|private-prompt/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(oauth.calls).toHaveLength(1);
  });

  it("marks a POST aborted inside fetch as an indeterminate non-retryable write", async () => {
    const oauth = new ScriptedOAuth(["oauth-token"]);
    let fetchStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        fetchStarted();
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal?.reason), {
            once: true,
          });
        });
      },
    ) as unknown as typeof fetch;
    const transport = new OAuthAnthropicRcTransport({ oauth, fetchFn });
    const abort = new AbortController();
    const pending = transport.request({
      operation: "postEvent",
      method: "POST",
      path: "/v1/code/sessions/cse_1/events",
      accept: "application/json",
      body: '{"events":[]}',
      signal: abort.signal,
    });

    await started;
    abort.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      kind: "network",
      retryable: false,
      outcomeUnknown: true,
    });
  });

  it("preserves safe credential diagnostics as terminal auth errors", async () => {
    const oauth: RcOAuthProvider = {
      async accessToken() {
        throw new ClaudeOAuthCredentialError(
          "INSECURE_PERMS",
          "Claude OAuth credentials must have mode 0600",
        );
      },
    };
    const transport = new OAuthAnthropicRcTransport({
      oauth,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    await expect(
      transport.request({
        operation: "listSessions",
        method: "GET",
        path: "/v1/code/sessions",
        accept: "application/json",
      }),
    ).rejects.toMatchObject({
      kind: "auth",
      authCode: "INSECURE_PERMS",
      status: null,
      retryable: false,
    });
  });

  it("does not trust even a typed credential error's caller-supplied message", async () => {
    const oauth: RcOAuthProvider = {
      async accessToken() {
        throw new ClaudeOAuthCredentialError("IO", "typed-error-secret-canary");
      },
    };
    const transport = new OAuthAnthropicRcTransport({
      oauth,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    const failure = transport.request({
      operation: "listSessions",
      method: "GET",
      path: "/v1/code/sessions",
      accept: "application/json",
    });
    await expect(failure).rejects.toMatchObject({
      kind: "auth",
      authCode: "IO",
      retryable: false,
    });
    await expect(failure).rejects.not.toThrow(/typed-error-secret-canary/);
  });

  it("masks arbitrary OAuth-provider errors instead of relabeling them as retryable network failures", async () => {
    const oauth: RcOAuthProvider = {
      async accessToken() {
        throw new Error("provider leaked oauth-token-canary");
      },
    };
    const transport = new OAuthAnthropicRcTransport({
      oauth,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    const failure = transport.request({
      operation: "listSessions",
      method: "GET",
      path: "/v1/code/sessions",
      accept: "application/json",
    });
    await expect(failure).rejects.toMatchObject({
      kind: "auth",
      authCode: "OAUTH_UNAVAILABLE",
      retryable: false,
    });
    await expect(failure).rejects.not.toThrow(/oauth-token-canary/);
  });

  it("sanitizes credential and fetch cancellation errors even when abort races their rejection", async () => {
    const credentialAbort = new AbortController();
    const oauth: RcOAuthProvider = {
      async accessToken() {
        const error = new AnthropicRcError(
          "auth",
          "private-operation-canary",
          null,
          false,
          "credential-typed-secret-canary",
        );
        credentialAbort.abort(error);
        throw error;
      },
    };
    const credentialTransport = new OAuthAnthropicRcTransport({
      oauth,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    const credentialFailure = credentialTransport.request({
      operation: "listSessions",
      method: "GET",
      path: "/v1/code/sessions",
      accept: "application/json",
      signal: credentialAbort.signal,
    });
    const credentialError = await credentialFailure.catch((caught: unknown) => caught);
    expect(credentialError).toMatchObject({ name: "AbortError" });
    expect(String(credentialError)).not.toMatch(
      /private-operation-canary|credential-typed-secret-canary/,
    );

    const fetchAbort = new AbortController();
    const fetchFn = vi.fn(async () => {
      fetchAbort.abort(new DOMException("fetch-signal-secret-canary", "TimeoutError"));
      throw new DOMException("fetch-error-secret-canary", "TimeoutError");
    }) as unknown as typeof fetch;
    const fetchTransport = new OAuthAnthropicRcTransport({
      oauth: new ScriptedOAuth(["oauth-token"]),
      fetchFn,
    });
    const fetchFailure = fetchTransport.request({
      operation: "history",
      method: "GET",
      path: "/v1/code/sessions/cse_1/events",
      accept: "application/json",
      signal: fetchAbort.signal,
    });
    const fetchError = await fetchFailure.catch((caught: unknown) => caught);
    expect(fetchError).toMatchObject({ name: "TimeoutError" });
    expect(String(fetchError)).not.toMatch(/fetch-signal-secret-canary|fetch-error-secret-canary/);
  });

  it.each([
    "https://attacker.invalid/v1/code/sessions",
    "/v1/code/sessions/../../messages",
    "/v1/code/sessions/%2e%2e/%2e%2e/messages",
    "/v1/code/sessions#outside",
  ])("rejects an absolute, non-RC, or normalized escape path before reading a credential", async (path) => {
    const oauth = new ScriptedOAuth(["must-not-be-read"]);
    const transport = new OAuthAnthropicRcTransport({
      oauth,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    await expect(
      transport.request({
        operation: "listSessions",
        method: "GET",
        path,
        accept: "application/json",
      }),
    ).rejects.toMatchObject({ kind: "protocol" });
    expect(oauth.calls).toHaveLength(0);
  });
});
