import { ClaudeOAuthCredentialError, type ClaudeOAuthCredentialErrorCode } from "./credentials.js";
import { AnthropicRcError } from "./errors.js";

export const ANTHROPIC_RC_ORIGIN = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface RcOAuthAccessTokenOptions {
  /**
   * A 401-triggered request for a newer token. A provider backed by Claude's shared credential file
   * must only wait for/reload a rotation performed by native Claude; it must not refresh or rewrite the
   * file itself.
   */
  forceRefresh: boolean;
  signal?: AbortSignal;
  /** Exact bearer rejected with 401, allowing a file provider to detect an already-completed rotation. */
  rejectedAccessToken?: string;
}

/** Supplies a bearer without exposing credential-file mechanics to the RC client. */
export interface RcOAuthProvider {
  accessToken(options: RcOAuthAccessTokenOptions): Promise<string>;
}

export interface AnthropicRcTransportRequest {
  operation: string;
  method: "GET" | "POST";
  /** Relative `/v1/code/...` path, including any encoded query string. */
  path: string;
  accept: "application/json" | "text/event-stream";
  body?: string;
  signal?: AbortSignal;
}

export interface AnthropicRcTransport {
  request(request: AnthropicRcTransportRequest): Promise<Response>;
}

export interface OAuthAnthropicRcTransportOptions {
  oauth: RcOAuthProvider;
  fetchFn?: typeof fetch;
}

/**
 * Authenticated transport for the fixed production RC origin. It reloads the OAuth bearer on every
 * request. On a 401 it asks the provider for a rotated token and retries the exact request at most once,
 * and only when the bearer actually changed. It never retries an ambiguous network failure.
 */
export class OAuthAnthropicRcTransport implements AnthropicRcTransport {
  readonly #oauth: RcOAuthProvider;
  readonly #fetch: typeof fetch;

  constructor(options: OAuthAnthropicRcTransportOptions) {
    this.#oauth = options.oauth;
    this.#fetch = options.fetchFn ?? globalThis.fetch;
  }

  async request(request: AnthropicRcTransportRequest): Promise<Response> {
    const url = rcUrl(request.path);
    const firstToken = await this.#accessToken(request, false);
    const first = await this.#fetchOnce(url, request, firstToken);
    if (responseStatus(first, request) !== 401) return first;

    // Do not leave a rejected body unread while waiting for Claude to rotate its shared credential.
    discardResponseBody(first);
    const nextToken = await this.#accessToken(request, true, firstToken);
    if (nextToken === firstToken) return first;
    return this.#fetchOnce(url, request, nextToken);
  }

  async #accessToken(
    request: AnthropicRcTransportRequest,
    forceRefresh: boolean,
    rejectedAccessToken?: string,
  ): Promise<string> {
    let accessToken: string;
    try {
      accessToken = await this.#oauth.accessToken({
        forceRefresh,
        ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (signalWasAborted(request.signal) || isAbortError(error)) {
        throw safeAbortError(error, request.signal);
      }
      const credentialCode = credentialErrorCode(error);
      if (credentialCode !== null) {
        throw AnthropicRcError.auth(
          request.operation,
          credentialCode,
          "native Claude's credential check failed",
          forceRefresh,
        );
      }
      throw AnthropicRcError.auth(
        request.operation,
        "OAUTH_UNAVAILABLE",
        "the configured OAuth provider failed",
        forceRefresh,
      );
    }
    if (typeof accessToken !== "string" || accessToken === "") {
      throw AnthropicRcError.auth(
        request.operation,
        "EMPTY_ACCESS_TOKEN",
        "the configured OAuth provider returned an empty access token",
        forceRefresh,
      );
    }
    return accessToken;
  }

  async #fetchOnce(
    url: URL,
    request: AnthropicRcTransportRequest,
    accessToken: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: request.accept,
      "anthropic-version": ANTHROPIC_VERSION,
      authorization: `Bearer ${accessToken}`,
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";

    try {
      return await this.#fetch(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        redirect: "error",
      });
    } catch (error) {
      if (signalWasAborted(request.signal) || isAbortError(error)) {
        if (request.method === "POST") {
          throw AnthropicRcError.aborted(request.operation, abortName(error, request.signal), true);
        }
        throw safeAbortError(error, request.signal);
      }
      throw AnthropicRcError.network(request.operation, {
        retryable: request.method === "GET",
        outcomeUnknown: request.method === "POST",
      });
    }
  }
}

function rcUrl(path: string): URL {
  // A fixed origin is a credential boundary: callers cannot redirect the bearer to a test or user URL.
  if (!path.startsWith("/v1/code/") || path.startsWith("//")) {
    throw AnthropicRcError.protocol("request", "invalid RC path");
  }
  const url = new URL(path, ANTHROPIC_RC_ORIGIN);
  // URL parsing resolves literal and percent-encoded dot segments. Recheck the normalized result so an
  // apparently RC-prefixed path cannot escape to another api.anthropic.com surface with the bearer.
  if (
    url.origin !== ANTHROPIC_RC_ORIGIN ||
    !url.pathname.startsWith("/v1/code/") ||
    url.hash !== ""
  ) {
    throw AnthropicRcError.protocol("request", "invalid RC path");
  }
  return url;
}

function isAbortError(error: unknown): boolean {
  return domExceptionName(error) !== null;
}

function abortName(error: unknown, signal: AbortSignal | undefined): "AbortError" | "TimeoutError" {
  const reason = signalReason(signal);
  if (domExceptionName(error) === "TimeoutError" || domExceptionName(reason) === "TimeoutError") {
    return "TimeoutError";
  }
  return "AbortError";
}

function signalWasAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted === true;
  } catch {
    return true;
  }
}

function signalReason(signal: AbortSignal | undefined): unknown {
  if (signal === undefined) return undefined;
  try {
    return signal.reason;
  } catch {
    return undefined;
  }
}

function domExceptionName(error: unknown): "AbortError" | "TimeoutError" | null {
  try {
    if (!(error instanceof DOMException)) return null;
    const name: unknown = error.name;
    return name === "AbortError" || name === "TimeoutError" ? name : null;
  } catch {
    return null;
  }
}

function safeAbortError(error: unknown, signal: AbortSignal | undefined): DOMException {
  const name = abortName(error, signal);
  return new DOMException(
    name === "TimeoutError" ? "The operation timed out" : "The operation was aborted",
    name,
  );
}

const CREDENTIAL_ERROR_CODES = new Set<string>([
  "UNSUPPORTED_PLATFORM",
  "NOT_FOUND",
  "SYMLINK_REFUSED",
  "NOT_A_FILE",
  "WRONG_OWNER",
  "INSECURE_PERMS",
  "TOO_LARGE",
  "MALFORMED",
  "MISSING_SESSIONS_SCOPE",
  "NO_REFRESH_TOKEN",
  "NO_REJECTED_TOKEN",
  "TOKEN_UNCHANGED",
  "IO",
] satisfies readonly ClaudeOAuthCredentialErrorCode[]);

function credentialErrorCode(error: unknown): string | null {
  try {
    if (!ClaudeOAuthCredentialError.is(error)) return null;
    const code: unknown = error.code;
    return typeof code === "string" && CREDENTIAL_ERROR_CODES.has(code)
      ? code
      : "OAUTH_UNAVAILABLE";
  } catch {
    return null;
  }
}

function responseStatus(response: Response, request: AnthropicRcTransportRequest): number {
  try {
    if (!(response instanceof Response)) throw new TypeError("invalid fetch Response");
    const status: unknown = Reflect.get(Response.prototype, "status", response);
    if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 599) {
      throw new TypeError("invalid fetch Response status");
    }
    return status;
  } catch {
    throw AnthropicRcError.network(request.operation, {
      retryable: request.method === "GET",
      outcomeUnknown: request.method === "POST",
    });
  }
}

function discardResponseBody(response: Response): void {
  try {
    const body = Reflect.get(
      Response.prototype,
      "body",
      response,
    ) as ReadableStream<Uint8Array> | null;
    if (body !== null) observeCleanup(ReadableStream.prototype.cancel.call(body));
  } catch {
    // A 401 body is diagnostic-only. Cleanup must not block token rotation or expose body errors.
  }
}

function observeCleanup(result: unknown): void {
  void (async () => {
    try {
      await result;
    } catch {
      // Await observes native promises without dynamically calling an own, monkey-patched `.catch`.
    }
  })();
}
