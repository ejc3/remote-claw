// Opt-in smoke for the current replacement-mode product path. It makes one real inference call and
// therefore runs only on an explicitly prepared machine:
//   pnpm --filter @remote-claw/web run test:real-claude
//   pnpm --filter @remote-claw/web run test:bedrock-accountless

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPass } from "@remote-claw/clawsec";
import { runRcLaunch, type Session } from "@remote-claw/cli/rc";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { PRETEND_API_KEY } from "../../../../packages/cli/src/host/rc/accountless.js";
import { resolveBedrockAuth } from "../../../../packages/cli/src/host/rc/bedrock/creds.js";
import { type Message, Viewer } from "../../app/lib/viewer";
import { brokerFetch } from "../e2e/harness";
import { uniqueIdentity } from "../helpers";

const ACCOUNTLESS_BEDROCK = process.env.RC_SMOKE_BEDROCK_ACCOUNTLESS === "1";
const RUN = process.env.RC_SMOKE_REAL_CLAUDE === "1" || ACCOUNTLESS_BEDROCK;
const CODEWORD = ACCOUNTLESS_BEDROCK ? "RC_BEDROCK_ACCOUNTLESS_OK" : "RC_REAL_SMOKE_OK";
const BEDROCK_REGION = "us-east-1";
const BEDROCK_MODEL = "anthropic.claude-opus-4-8";

function requireAccountlessTuple(): string {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("accountless Bedrock smoke requires Linux arm64");
  }
  const claudeBin = process.env.RC_CLAUDE_BIN?.trim();
  if (!claudeBin) throw new Error("accountless Bedrock smoke requires RC_CLAUDE_BIN");

  // The accepted credential tuple is specifically temporary IMDSv2 SigV4. Reject every credential
  // source our resolver would prefer over IMDS so a green run cannot silently exercise another path.
  for (const name of [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  ]) {
    if (process.env[name]?.trim()) {
      throw new Error("accountless Bedrock smoke requires IMDS-only host credentials");
    }
  }
  return claudeBin;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!predicate()) throw new Error("real Claude smoke timed out");
}

async function terminateGroup(child: ChildProcess | null): Promise<void> {
  if (child?.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

afterAll(async () => {
  await teardownWorkflowTests();
});

describe.skipIf(!RUN)("real Claude replacement-mode smoke", () => {
  it("moves one viewer turn through runRcLaunch and leaves Claude alive until teardown", async () => {
    const identity = await uniqueIdentity();
    const scratch = mkdtempSync(join(tmpdir(), "remote-claw-real-smoke-"));
    const claudeBin = ACCOUNTLESS_BEDROCK
      ? requireAccountlessTuple()
      : process.env.RC_CLAUDE_BIN?.trim() || "claude";
    const cwd = ACCOUNTLESS_BEDROCK
      ? join(scratch, "empty-worktree")
      : (process.env.RC_SMOKE_CLAUDE_CWD ?? process.cwd());
    if (ACCOUNTLESS_BEDROCK) mkdirSync(cwd, { mode: 0o700 });
    if (!existsSync(cwd)) throw new Error("RC_SMOKE_CLAUDE_CWD does not exist");
    if (ACCOUNTLESS_BEDROCK && (statSync(cwd).mode & 0o777) !== 0o700) {
      throw new Error("accountless Bedrock smoke worktree is not mode 0700");
    }

    const viewer = await Viewer.fromPass(
      await formatPass(identity),
      "https://broker",
      brokerFetch,
      "sqlite",
    );
    const transcriptAbort = new AbortController();
    const presenceAbort = new AbortController();
    const messages: Message[] = [];
    const announced = new Set<string>();
    let session: Session | null = null;
    let pty: ChildProcess | null = null;
    let launchSettled = false;
    let presenceError: unknown;
    let launchError: unknown;
    let accountlessAuthVerified = false;
    let transcript: Promise<void> = Promise.resolve();
    const presence = (async () => {
      for await (const announcement of viewer.announces(presenceAbort.signal)) {
        announced.add(announcement.sessionId);
      }
    })().catch((error: unknown) => {
      if (!presenceAbort.signal.aborted) presenceError = error;
    });

    const launch = runRcLaunch({
      claudeArgs: ["--safe-mode", "--tools", "", "--remote-control", "remote-claw-smoke"],
      identity,
      brokerUrl: "https://broker",
      backend: "sqlite",
      certsDir: join(scratch, "certs"),
      claudeBin,
      cwd,
      fetchFn: brokerFetch,
      ...(ACCOUNTLESS_BEDROCK
        ? {
            inference: "bedrock" as const,
            accountless: true,
            bedrock: {
              region: BEDROCK_REGION,
              modelOverride: BEDROCK_MODEL,
              resolveAuth: async () => {
                const auth = await resolveBedrockAuth();
                if (
                  auth.kind !== "sigv4" ||
                  !auth.credentials.sessionToken ||
                  auth.credentials.expiration === undefined ||
                  auth.credentials.expiration <= Date.now() + 60_000
                ) {
                  throw new Error(
                    "accountless Bedrock smoke requires unexpired temporary IMDS credentials",
                  );
                }
                accountlessAuthVerified = true;
                return auth;
              },
            },
          }
        : {}),
      onSession: (value) => {
        session = value;
      },
      spawnClaude: (bin, args, env) => {
        if (ACCOUNTLESS_BEDROCK) {
          const configDir = env.CLAUDE_CONFIG_DIR;
          const childAws = Object.keys(env).filter(
            (name) => name.startsWith("AWS_") && name !== "AWS_EC2_METADATA_DISABLED",
          );
          if (
            !configDir ||
            configDir === process.env.CLAUDE_CONFIG_DIR ||
            !existsSync(configDir) ||
            env.ANTHROPIC_AUTH_TOKEN !== undefined ||
            env.ANTHROPIC_IDENTITY_TOKEN !== undefined ||
            env.CLAUDE_CODE_OAUTH_TOKEN !== undefined ||
            env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN !== undefined ||
            env.CLAUDE_CODE_SESSION_ACCESS_TOKEN !== undefined ||
            env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR !== undefined ||
            env.CLAUDE_CODE_API_BASE_URL !== undefined ||
            env.CLAUDE_SESSION_INGRESS_TOKEN_FILE !== undefined ||
            env.CCR_OAUTH_TOKEN_FILE !== undefined ||
            env.CLAUDE_CODE_MANAGED_SETTINGS_PATH !== undefined ||
            env.CLAUDE_CODE_MOCK_REMOTE_SETTINGS !== undefined ||
            env.CLAUDE_CODE_REMOTE_SETTINGS_PATH !== undefined ||
            env.ANTHROPIC_CUSTOM_HEADERS !== undefined ||
            env.ANTHROPIC_BASE_URL !== undefined ||
            env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== configDir ||
            env.ANTHROPIC_CONFIG_DIR !== configDir ||
            env.ANTHROPIC_API_KEY !== PRETEND_API_KEY ||
            env.AWS_EC2_METADATA_DISABLED !== "true" ||
            childAws.length !== 0
          ) {
            throw new Error("accountless Bedrock child environment isolation failed");
          }
        }
        return new Promise<number>((resolve, reject) => {
          const command = `exec ${[bin, ...args].map(shellQuote).join(" ")}`;
          const child = spawn("script", ["-qefc", command, "/dev/null"], {
            cwd,
            detached: true,
            env: { ...env, TERM: "xterm-256color" },
            stdio: ["pipe", "ignore", "ignore"],
          });
          pty = child;
          child.once("error", reject);
          child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
        });
      },
    })
      .catch((error: unknown) => {
        launchError = error;
        return 1;
      })
      .finally(() => {
        launchSettled = true;
      });

    try {
      await waitFor(() => session !== null || launchSettled, 90_000);
      if (session === null) {
        if (launchError !== undefined) throw launchError;
        throw new Error("real Claude exited before session registration");
      }
      const sessionId = (session as unknown as Session).id;
      await waitFor(
        () => announced.has(sessionId) || launchSettled || presenceError !== undefined,
        90_000,
      );
      if (presenceError !== undefined) throw presenceError;
      if (!announced.has(sessionId)) {
        throw new Error("real Claude exited before its ready bridge announced the session");
      }
      transcript = (async () => {
        for await (const message of viewer.transcript(sessionId, transcriptAbort.signal)) {
          messages.push(message);
        }
      })().catch((error: unknown) => {
        if (!transcriptAbort.signal.aborted) throw error;
      });

      await viewer.sendPrompt(sessionId, `Reply with exactly: ${CODEWORD}`);
      const completed = () =>
        messages.some(
          (message) => message.kind === "assistant" && message.text.includes(CODEWORD),
        ) && messages.some((message) => message.kind === "result");
      await waitFor(() => completed() || launchSettled, 180_000);
      expect(completed()).toBe(true);
      expect(launchSettled).toBe(false);
      if (ACCOUNTLESS_BEDROCK) expect(accountlessAuthVerified).toBe(true);
    } finally {
      transcriptAbort.abort();
      presenceAbort.abort();
      await transcript;
      await presence;
      await terminateGroup(pty);
      await launch;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 300_000);
});
