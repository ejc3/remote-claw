import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_OAUTH_CREDENTIAL_MAX_BYTES,
  ClaudeOAuthCredentialError,
  ClaudeOAuthFileCredentialSource,
  claudeCredentialsPath,
} from "./credentials.js";

const ACCESS = "access-token-canary";
const REFRESH = "refresh-token-canary";
const SESSIONS_SCOPE = "user:sessions:claude_code";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rc-claude-oauth-"));
  cleanup.push(dir);
  return dir;
}

function credential(
  accessToken = ACCESS,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mcpOAuth: { mustRemainUntouched: true },
    claudeAiOauth: {
      accessToken,
      refreshToken: REFRESH,
      expiresAt: Date.now() + 60_000,
      refreshTokenExpiresAt: Date.now() + 120_000,
      scopes: ["user:profile", SESSIONS_SCOPE],
      subscriptionType: "max",
      ...overrides,
    },
  };
}

function writeCredential(dir: string, value: unknown = credential()): string {
  const path = join(dir, ".credentials.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function source(
  dir: string,
  options: { platform?: NodeJS.Platform; pollMs?: number; waitTimeoutMs?: number } = {},
): ClaudeOAuthFileCredentialSource {
  return new ClaudeOAuthFileCredentialSource({
    env: { CLAUDE_CONFIG_DIR: dir },
    homedir: () => "/must-not-be-used",
    ...options,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ClaudeOAuthCredentialError);
  expect((error as ClaudeOAuthCredentialError).code).toBe(code);
  expect(String(error)).not.toContain(ACCESS);
  expect(String(error)).not.toContain(REFRESH);
}

describe("claudeCredentialsPath", () => {
  it("uses CLAUDE_CONFIG_DIR when set and otherwise the fixed ~/.claude path", () => {
    expect(
      claudeCredentialsPath({
        env: { CLAUDE_CONFIG_DIR: "/custom/claude" },
        homedir: () => "/home/tester",
      }),
    ).toBe("/custom/claude/.credentials.json");
    expect(
      claudeCredentialsPath({
        env: {},
        homedir: () => "/home/tester",
      }),
    ).toBe("/home/tester/.claude/.credentials.json");
  });
});

describe("ClaudeOAuthFileCredentialSource platform boundary", () => {
  it.each([
    "darwin",
    "win32",
  ] as const)("fails closed on %s until a native secure provider exists", async (platform) => {
    const dir = tempDir();
    writeCredential(dir);
    await expectCode(source(dir, { platform }).accessToken(), "UNSUPPORTED_PLATFORM");
  });
});

describe.skipIf(process.platform !== "linux")("ClaudeOAuthFileCredentialSource", () => {
  it("securely rereads the current token per request without modifying the credential file", async () => {
    const dir = tempDir();
    const file = writeCredential(dir);
    const before = readFileSync(file);
    const provider = source(dir);

    await expect(provider.accessToken()).resolves.toBe(ACCESS);
    expect(readFileSync(file)).toEqual(before);

    const rotated = "rotated-access-token-canary";
    writeCredential(dir, credential(rotated));
    await expect(provider.accessToken()).resolves.toBe(rotated);
  });

  it("accepts extra top-level and oauth metadata but validates the required strict fields", async () => {
    const dir = tempDir();
    writeCredential(dir);
    await expect(source(dir).accessToken()).resolves.toBe(ACCESS);
  });

  it.each([
    ["MALFORMED", null],
    ["MALFORMED", []],
    ["MALFORMED", {}],
    ["MALFORMED", { claudeAiOauth: [] }],
    ["MALFORMED", credential(ACCESS, { accessToken: "" })],
    ["NO_REFRESH_TOKEN", credential(ACCESS, { refreshToken: "" })],
    ["MALFORMED", credential(ACCESS, { expiresAt: "soon" })],
    ["MALFORMED", credential(ACCESS, { refreshTokenExpiresAt: "later" })],
    ["MALFORMED", credential(ACCESS, { scopes: [SESSIONS_SCOPE, 7] })],
    ["MISSING_SESSIONS_SCOPE", credential(ACCESS, { scopes: ["user:profile"] })],
  ])("rejects invalid schema with %s and no credential echo", async (code, value) => {
    const dir = tempDir();
    writeCredential(dir, value);
    await expectCode(source(dir).accessToken(), code);
  });

  it("refuses a missing, symlink, non-regular, or non-0600 credential target", async () => {
    const missing = tempDir();
    await expectCode(source(missing).accessToken(), "NOT_FOUND");

    const symlinkDir = tempDir();
    const target = join(symlinkDir, "target.json");
    writeFileSync(target, `${JSON.stringify(credential())}\n`, { mode: 0o600 });
    symlinkSync(target, join(symlinkDir, ".credentials.json"));
    await expectCode(source(symlinkDir).accessToken(), "SYMLINK_REFUSED");

    const directory = tempDir();
    mkdirSync(join(directory, ".credentials.json"));
    await expectCode(source(directory).accessToken(), "NOT_A_FILE");

    const permissive = tempDir();
    const permissiveFile = writeCredential(permissive);
    chmodSync(permissiveFile, 0o640);
    await expectCode(source(permissive).accessToken(), "INSECURE_PERMS");
  });

  it("enforces the read bound before parsing", async () => {
    const dir = tempDir();
    const file = join(dir, ".credentials.json");
    writeFileSync(file, Buffer.alloc(CLAUDE_OAUTH_CREDENTIAL_MAX_BYTES + 1, 0x78), {
      mode: 0o600,
    });
    await expectCode(source(dir).accessToken(), "TOO_LARGE");
  });

  it("rejects invalid UTF-8 instead of changing credential bytes", async () => {
    const dir = tempDir();
    const bytes = Buffer.from(JSON.stringify(credential()));
    const tokenOffset = bytes.indexOf(ACCESS);
    expect(tokenOffset).toBeGreaterThanOrEqual(0);
    bytes[tokenOffset] = 0xff;
    writeFileSync(join(dir, ".credentials.json"), bytes, { mode: 0o600 });

    await expectCode(source(dir).accessToken(), "MALFORMED");
  });

  it("waits for native Claude to atomically rotate a rejected token, without writing itself", async () => {
    const dir = tempDir();
    const file = writeCredential(dir);
    const provider = source(dir, { pollMs: 5, waitTimeoutMs: 500 });
    await expect(provider.accessToken()).resolves.toBe(ACCESS);

    const rotated = "native-rotated-access-token-canary";
    const pending = provider.accessToken({
      forceRefresh: true,
      rejectedAccessToken: ACCESS,
    });
    const replacement = join(dir, ".credentials.replacement");
    writeFileSync(replacement, `${JSON.stringify(credential(rotated))}\n`, { mode: 0o600 });
    renameSync(replacement, file);

    await expect(pending).resolves.toBe(rotated);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpOAuth).toEqual({
      mustRemainUntouched: true,
    });
  });

  it("adopts a token that changed before forceRefresh entered the wait path", async () => {
    const dir = tempDir();
    writeCredential(dir);
    const provider = source(dir, { pollMs: 5, waitTimeoutMs: 100 });
    await expect(provider.accessToken()).resolves.toBe(ACCESS);

    const rotated = "already-rotated-access-token-canary";
    writeCredential(dir, credential(rotated));
    await expect(
      provider.accessToken({
        forceRefresh: true,
        rejectedAccessToken: ACCESS,
      }),
    ).resolves.toBe(rotated);
  });

  it("fails safely when no token changes or no request-specific rejected token is supplied", async () => {
    const dir = tempDir();
    writeCredential(dir);
    const provider = source(dir, { pollMs: 2, waitTimeoutMs: 5 });

    await expectCode(provider.accessToken({ forceRefresh: true }), "NO_REJECTED_TOKEN");
    await expectCode(
      provider.accessToken({
        forceRefresh: true,
        rejectedAccessToken: ACCESS,
      }),
      "TOKEN_UNCHANGED",
    );
  });

  it("honors an already-aborted or mid-wait AbortSignal", async () => {
    const dir = tempDir();
    writeCredential(dir);
    const provider = source(dir, { pollMs: 50, waitTimeoutMs: 500 });
    await expect(provider.accessToken()).resolves.toBe(ACCESS);

    const already = new AbortController();
    already.abort();
    await expect(provider.accessToken({ signal: already.signal })).rejects.toMatchObject({
      name: "AbortError",
    });

    const waiting = new AbortController();
    const pending = provider.accessToken({
      forceRefresh: true,
      rejectedAccessToken: ACCESS,
      signal: waiting.signal,
    });
    waiting.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
