export type AnthropicRcErrorKind = "auth" | "http" | "network" | "protocol";

const SAFE_AUTH_CODES = new Set([
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
  "OAUTH_UNAVAILABLE",
  "EMPTY_ACCESS_TOKEN",
]);

/**
 * A deliberately low-detail error from the Anthropic Remote Control client. Response bodies and
 * underlying transport errors are not retained: either can contain credentials or user content.
 */
export class AnthropicRcError extends Error {
  constructor(
    readonly kind: AnthropicRcErrorKind,
    readonly operation: string,
    readonly status: number | null,
    readonly retryable: boolean,
    message: string,
    /** Stable credential/config code for `kind:"auth"`; never a token or response-body detail. */
    readonly authCode: string | null = null,
    /** True only when a write may have reached Anthropic but no canonical result was received. */
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "AnthropicRcError";
  }

  static http(
    operation: string,
    status: number,
    options: { write?: boolean } = {},
  ): AnthropicRcError {
    const write = options.write ?? false;
    // Fetch represents an opaque/network-error Response with status 0. It is not a known HTTP
    // rejection, so a write may have reached the server and must never be advertised as replayable.
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return AnthropicRcError.network(operation, {
        retryable: !write,
        outcomeUnknown: write,
      });
    }
    const transient = status === 408 || status === 429 || status >= 500;
    return new AnthropicRcError(
      "http",
      operation,
      status,
      transient && !write,
      `${operation} failed with HTTP ${status}`,
      null,
      write && (status === 408 || status >= 500),
    );
  }

  static network(
    operation: string,
    options: { retryable?: boolean; outcomeUnknown?: boolean } = {},
  ): AnthropicRcError {
    return new AnthropicRcError(
      "network",
      operation,
      null,
      options.retryable ?? true,
      `${operation} failed at the network boundary`,
      null,
      options.outcomeUnknown ?? false,
    );
  }

  static protocol(
    operation: string,
    detail: string,
    options: { outcomeUnknown?: boolean } = {},
  ): AnthropicRcError {
    return new AnthropicRcError(
      "protocol",
      operation,
      null,
      false,
      `${operation} returned an invalid protocol shape (${detail})`,
      null,
      options.outcomeUnknown ?? false,
    );
  }

  static aborted(
    operation: string,
    name: "AbortError" | "TimeoutError",
    outcomeUnknown: boolean,
  ): AnthropicRcError {
    const error = new AnthropicRcError(
      "network",
      operation,
      null,
      false,
      `${operation} was ${name === "TimeoutError" ? "timed out" : "aborted"}`,
      null,
      outcomeUnknown,
    );
    // Preserve the conventional cancellation name while retaining typed write-outcome metadata.
    error.name = name;
    return error;
  }

  static auth(
    operation: string,
    authCode: string,
    message: string,
    afterUnauthorized = false,
  ): AnthropicRcError {
    return new AnthropicRcError(
      "auth",
      operation,
      afterUnauthorized ? 401 : null,
      false,
      `${operation} cannot use Claude OAuth credentials (${authCode}): ${message}`,
      authCode,
    );
  }

  /**
   * Copy a typed error received across an injectable boundary without trusting its public message,
   * operation, status, or auth code. This also protects cancellation races where an arbitrary
   * AbortSignal reason is itself an AnthropicRcError.
   */
  static is(error: unknown): error is AnthropicRcError {
    try {
      return error instanceof AnthropicRcError;
    } catch {
      return false;
    }
  }

  static sanitized(
    error: AnthropicRcError,
    operation: string,
    options: { write?: boolean } = {},
  ): AnthropicRcError {
    const write = options.write ?? false;
    let rawKind: unknown;
    let rawStatus: unknown;
    let rawRetryable: unknown;
    let rawAuthCode: unknown;
    let rawOutcomeUnknown: unknown;
    let rawName: unknown;
    try {
      rawKind = error.kind;
      rawStatus = error.status;
      rawRetryable = error.retryable;
      rawAuthCode = error.authCode;
      rawOutcomeUnknown = error.outcomeUnknown;
      rawName = error.name;
    } catch {
      return AnthropicRcError.network(operation, {
        retryable: !write,
        outcomeUnknown: write,
      });
    }
    const kind: AnthropicRcErrorKind =
      rawKind === "auth" || rawKind === "http" || rawKind === "network" || rawKind === "protocol"
        ? rawKind
        : "network";
    const status =
      typeof rawStatus === "number" &&
      Number.isInteger(rawStatus) &&
      rawStatus >= 100 &&
      rawStatus <= 599
        ? rawStatus
        : null;
    const authCode =
      kind === "auth" && typeof rawAuthCode === "string" && SAFE_AUTH_CODES.has(rawAuthCode)
        ? rawAuthCode
        : null;
    const safe = new AnthropicRcError(
      kind,
      operation,
      status,
      write ? false : rawRetryable === true,
      `${operation} failed (${kind})`,
      authCode,
      write ? true : rawOutcomeUnknown === true,
    );
    if (rawName === "AbortError" || rawName === "TimeoutError") safe.name = rawName;
    return safe;
  }
}
