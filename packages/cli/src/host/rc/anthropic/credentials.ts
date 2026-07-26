// Read-only access on Linux to the Claude login that the native `claude` process already owns.
//
// This module deliberately does NOT refresh or persist OAuth credentials. Claude's refresh tokens
// rotate, and Claude coordinates refreshes with its own lock/CAS protocol; a second writer could
// invalidate Claude's token or clobber unrelated credentials in the same JSON file. The RC transport
// asks for a fresh file snapshot per request. After a 401 it may ask us to wait until native Claude
// has replaced the rejected access token on disk.

import { closeSync, constants as FS, fstatSync, openSync, readSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CLAUDE_OAUTH_CREDENTIAL_MAX_BYTES = 1024 * 1024;
const DEFAULT_POLL_MS = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const REQUIRED_SESSIONS_SCOPE = "user:sessions:claude_code";

export type ClaudeOAuthCredentialErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "NOT_FOUND"
  | "SYMLINK_REFUSED"
  | "NOT_A_FILE"
  | "WRONG_OWNER"
  | "INSECURE_PERMS"
  | "TOO_LARGE"
  | "MALFORMED"
  | "MISSING_SESSIONS_SCOPE"
  | "NO_REFRESH_TOKEN"
  | "NO_REJECTED_TOKEN"
  | "TOKEN_UNCHANGED"
  | "IO";

/** A stable, secret-free failure suitable for CLI diagnostics and transport policy. */
export class ClaudeOAuthCredentialError extends Error {
  readonly code: ClaudeOAuthCredentialErrorCode;

  constructor(code: ClaudeOAuthCredentialErrorCode, message: string) {
    super(message);
    this.name = "ClaudeOAuthCredentialError";
    this.code = code;
  }

  static is(error: unknown): error is ClaudeOAuthCredentialError {
    return error instanceof ClaudeOAuthCredentialError;
  }
}

export interface ClaudeCredentialsPathOptions {
  /** Injected environment for tests. Production defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected home-directory resolver for tests. Production defaults to os.homedir. */
  homedir?: () => string;
}

/**
 * Resolve Claude's one credential file. With CLAUDE_CONFIG_DIR, Claude stores it directly in that
 * directory; otherwise it lives under ~/.claude. There is intentionally no arbitrary file override.
 */
export function claudeCredentialsPath(options: ClaudeCredentialsPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = (options.homedir ?? osHomedir)();
  const configured = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  const dir = configured === "" ? join(home, ".claude") : configured;
  return isAbsolute(dir) ? join(dir, ".credentials.json") : resolve(dir, ".credentials.json");
}

export interface ClaudeOAuthAccessTokenOptions {
  /**
   * False/omitted: securely reread and return the current file token.
   * True: never perform OAuth refresh; wait for native Claude to replace the rejected token on disk.
   */
  forceRefresh?: boolean;
  signal?: AbortSignal;
  /**
   * The exact token rejected with 401. Supplying it closes the race where another request observes
   * Claude's replacement before this request enters the wait path.
   */
  rejectedAccessToken?: string;
}

/** Minimal auth seam consumed by AnthropicRcClient's transport. Refresh remains native-Claude-owned. */
export interface ClaudeOAuthCredentialSource {
  accessToken(options?: ClaudeOAuthAccessTokenOptions): Promise<string>;
}

export interface ClaudeOAuthFileCredentialSourceOptions extends ClaudeCredentialsPathOptions {
  /** Injected platform for tests. The built-in file reader intentionally supports Linux only. */
  platform?: NodeJS.Platform;
  /** Poll interval while waiting for native Claude's refresh (default 100 ms). */
  pollMs?: number;
  /** Maximum wait after a 401 (default 10 seconds). */
  waitTimeoutMs?: number;
  /** Injected monotonic-enough wall clock for deterministic tests. */
  now?: () => number;
}

interface ParsedClaudeOAuthCredential {
  accessToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes: readonly string[];
}

/**
 * Linux file-backed source for Claude's existing login. Every call opens a new fd, so an atomic
 * credential-file replacement by native Claude is observed without sharing mutable token state.
 */
export class ClaudeOAuthFileCredentialSource implements ClaudeOAuthCredentialSource {
  readonly #path: string;
  readonly #platform: NodeJS.Platform;
  readonly #pollMs: number;
  readonly #waitTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: ClaudeOAuthFileCredentialSourceOptions = {}) {
    this.#path = claudeCredentialsPath(options);
    this.#platform = options.platform ?? process.platform;
    this.#pollMs = positiveFinite(options.pollMs ?? DEFAULT_POLL_MS, "pollMs");
    this.#waitTimeoutMs = nonNegativeFinite(
      options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      "waitTimeoutMs",
    );
    this.#now = options.now ?? Date.now;
  }

  async accessToken(options: ClaudeOAuthAccessTokenOptions = {}): Promise<string> {
    throwIfAborted(options.signal);
    if (options.forceRefresh !== true) {
      return readClaudeOAuthCredential(this.#path, this.#platform).accessToken;
    }

    const rejected = options.rejectedAccessToken;
    if (rejected === undefined || rejected === "") {
      throw new ClaudeOAuthCredentialError(
        "NO_REJECTED_TOKEN",
        "cannot wait for Claude OAuth rotation without a previously issued access token",
      );
    }

    const deadline = this.#now() + this.#waitTimeoutMs;
    for (;;) {
      throwIfAborted(options.signal);
      const credential = readClaudeOAuthCredential(this.#path, this.#platform);
      if (credential.accessToken !== rejected) {
        return credential.accessToken;
      }

      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        throw new ClaudeOAuthCredentialError(
          "TOKEN_UNCHANGED",
          "native Claude did not rotate its OAuth access token after the request was rejected",
        );
      }
      await abortableDelay(Math.min(this.#pollMs, remaining), options.signal);
    }
  }
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function readClaudeOAuthCredential(
  path: string,
  platform: NodeJS.Platform,
): ParsedClaudeOAuthCredential {
  if (
    platform !== "linux" ||
    typeof process.getuid !== "function" ||
    typeof FS.O_NOFOLLOW !== "number"
  ) {
    throw new ClaudeOAuthCredentialError(
      "UNSUPPORTED_PLATFORM",
      "the built-in Claude OAuth credential-file reader supports Linux only",
    );
  }

  let fd: number;
  try {
    fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ClaudeOAuthCredentialError(
        "NOT_FOUND",
        "Claude OAuth credentials were not found; log in with native Claude first",
      );
    }
    if (code === "ELOOP") {
      throw new ClaudeOAuthCredentialError(
        "SYMLINK_REFUSED",
        "refusing to follow a symlink for Claude OAuth credentials",
      );
    }
    throw new ClaudeOAuthCredentialError("IO", "could not open Claude OAuth credentials");
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new ClaudeOAuthCredentialError(
        "NOT_A_FILE",
        "Claude OAuth credentials are not a regular file",
      );
    }
    if (stat.uid !== process.getuid()) {
      throw new ClaudeOAuthCredentialError(
        "WRONG_OWNER",
        "Claude OAuth credentials are not owned by the current user",
      );
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new ClaudeOAuthCredentialError(
        "INSECURE_PERMS",
        "Claude OAuth credentials must have mode 0600",
      );
    }
    if (stat.size > CLAUDE_OAUTH_CREDENTIAL_MAX_BYTES) {
      throw new ClaudeOAuthCredentialError(
        "TOO_LARGE",
        "Claude OAuth credential file exceeds the safe size limit",
      );
    }
    return parseClaudeOAuthCredential(readBounded(fd));
  } catch (error) {
    if (ClaudeOAuthCredentialError.is(error)) throw error;
    throw new ClaudeOAuthCredentialError("IO", "could not read Claude OAuth credentials");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close error must not replace the primary read/validation result.
    }
  }
}

/** Read at most cap+1 bytes so concurrent growth cannot bypass the pre-read fstat bound. */
function readBounded(fd: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const room = CLAUDE_OAUTH_CREDENTIAL_MAX_BYTES + 1 - total;
    if (room <= 0) {
      throw new ClaudeOAuthCredentialError(
        "TOO_LARGE",
        "Claude OAuth credential file exceeds the safe size limit",
      );
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, room));
    const read = readSync(fd, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    chunks.push(buffer.subarray(0, read));
    if (total > CLAUDE_OAUTH_CREDENTIAL_MAX_BYTES) {
      throw new ClaudeOAuthCredentialError(
        "TOO_LARGE",
        "Claude OAuth credential file exceeds the safe size limit",
      );
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw malformed();
  }
}

function parseClaudeOAuthCredential(text: string): ParsedClaudeOAuthCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed();
  }
  if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) throw malformed();
  const oauth = parsed.claudeAiOauth;
  const accessToken = oauth.accessToken;
  const refreshToken = oauth.refreshToken;
  const expiresAt = oauth.expiresAt;
  const refreshTokenExpiresAt = oauth.refreshTokenExpiresAt;
  const scopes = oauth.scopes;

  if (typeof accessToken !== "string" || accessToken.trim() === "") throw malformed();
  if (typeof refreshToken !== "string" || refreshToken.trim() === "") {
    throw new ClaudeOAuthCredentialError(
      "NO_REFRESH_TOKEN",
      "Claude OAuth credentials do not include a native-Claude-owned refresh token",
    );
  }
  if (!Number.isFinite(expiresAt) || (expiresAt as number) <= 0) throw malformed();
  if (
    refreshTokenExpiresAt !== undefined &&
    (!Number.isFinite(refreshTokenExpiresAt) || (refreshTokenExpiresAt as number) <= 0)
  ) {
    throw malformed();
  }
  if (
    !Array.isArray(scopes) ||
    scopes.some((scope) => typeof scope !== "string" || scope.trim() === "")
  ) {
    throw malformed();
  }
  if (!scopes.includes(REQUIRED_SESSIONS_SCOPE)) {
    throw new ClaudeOAuthCredentialError(
      "MISSING_SESSIONS_SCOPE",
      "Claude OAuth credentials do not grant the Remote Control sessions scope",
    );
  }

  return {
    accessToken,
    expiresAt: expiresAt as number,
    ...(typeof refreshTokenExpiresAt === "number" ? { refreshTokenExpiresAt } : {}),
    scopes: [...scopes],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): ClaudeOAuthCredentialError {
  return new ClaudeOAuthCredentialError(
    "MALFORMED",
    "Claude OAuth credential file has an invalid claudeAiOauth schema",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signalWasAborted(signal)) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signalWasAborted(signal)) return Promise.reject(abortError());
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function signalWasAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted === true;
  } catch {
    return true;
  }
}
