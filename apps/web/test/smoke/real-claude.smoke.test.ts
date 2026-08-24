// Opt-in smoke for the current replacement-mode product path. It makes one real inference call and
// therefore runs only on an explicitly prepared, logged-in machine:
//   pnpm --filter @remote-claw/web run test:real-claude

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPass } from "@remote-claw/clawsec";
import { runRcLaunch, type Session } from "@remote-claw/cli/rc";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { type Message, Viewer } from "../../app/lib/viewer";
import { brokerFetch } from "../e2e/harness";
import { uniqueIdentity } from "../helpers";

const RUN = process.env.RC_SMOKE_REAL_CLAUDE === "1";
const CODEWORD = "RC_REAL_SMOKE_OK";

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
    const cwd = process.env.RC_SMOKE_CLAUDE_CWD ?? process.cwd();
    if (!existsSync(cwd)) throw new Error("RC_SMOKE_CLAUDE_CWD does not exist");

    const viewer = await Viewer.fromPass(
      await formatPass(identity),
      "http://broker",
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
      brokerUrl: "http://broker",
      backend: "sqlite",
      certsDir: join(scratch, "certs"),
      cwd,
      fetchFn: brokerFetch,
      onSession: (value) => {
        session = value;
      },
      spawnClaude: (bin, args, env) =>
        new Promise<number>((resolve, reject) => {
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
        }),
    })
      .catch(() => 1)
      .finally(() => {
        launchSettled = true;
      });

    try {
      await waitFor(() => session !== null || launchSettled, 90_000);
      if (session === null) throw new Error("real Claude exited before session registration");
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
