// Opt-in M4 acceptance. This is intentionally one outcome test, not part of ordinary PR CI:
//   CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-1 AWS_DEFAULT_REGION=us-west-1 \
//   RC_TMUX_LIVE_MODEL=global.anthropic.claude-sonnet-4-6 \
//   RC_TMUX_LIVE_CLI=/path/to/packed-installed/remote-claw \
//   RC_TMUX_LIVE_CLAUDE=/path/to/claude-2.1.237 RC_TMUX_LIVE_CWD=/path/to/a/pre-trusted/project \
//   pnpm test:tmux-live
//
// It uses two real Chromium contexts, a real local broker, the packed-installed CLI, real tmux, and
// real Claude. M4 deliberately makes no provider-side or official-client coexistence claim.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type BrowserContext, expect, test } from "@playwright/test";

const exec = promisify(execFile);
const cli = process.env.RC_TMUX_LIVE_CLI;
const claude = process.env.RC_TMUX_LIVE_CLAUDE;
const cwd = process.env.RC_TMUX_LIVE_CWD;
const model = process.env.RC_TMUX_LIVE_MODEL;

async function waitFor<T>(
  probe: () => T | Promise<T>,
  timeoutMs = 180_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await probe();
  }
  if (!value) throw new Error("timed out waiting for the M4 live outcome");
  return value as NonNullable<T>;
}

async function body(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: string,
  inFlight: Set<AbortController>,
): Promise<void> {
  const abort = new AbortController();
  inFlight.add(abort);
  res.once("close", () => abort.abort());
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === "host" || name === "connection" || value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else headers.set(name, value);
    }
    headers.set("accept-encoding", "identity");
    const requestBody = await body(req);
    const upstream = await fetch(new URL(req.url ?? "/", target), {
      method: req.method ?? "GET",
      headers,
      redirect: "manual",
      signal: abort.signal,
      ...(requestBody !== undefined ? { body: requestBody as BodyInit } : {}),
    });
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!STRIP_RESPONSE_HEADERS.has(name)) responseHeaders[name] = value;
    });
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body !== null) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  } finally {
    inFlight.delete(abort);
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function assistantText(line: string): string {
  try {
    const entry = JSON.parse(line) as {
      type?: unknown;
      message?: { content?: unknown };
    };
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) return "";
    return entry.message.content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const value = part as { type?: unknown; text?: unknown };
        return value.type === "text" && typeof value.text === "string" ? value.text : "";
      })
      .join("\n");
  } catch {
    return "";
  }
}

test("M4: browsers depart, local permission survives, then broker loss is isolated", async ({
  browser,
  baseURL,
}) => {
  if (process.env.RC_TMUX_LIVE !== "1") throw new Error("RC_TMUX_LIVE=1 is required");
  if (
    cli === undefined ||
    claude === undefined ||
    cwd === undefined ||
    model === undefined ||
    baseURL === undefined
  ) {
    throw new Error(
      "RC_TMUX_LIVE_CLI, RC_TMUX_LIVE_CLAUDE, RC_TMUX_LIVE_CWD, and RC_TMUX_LIVE_MODEL are required",
    );
  }
  expect(`${process.platform}-${process.arch}`).toBe("linux-arm64");
  expect((await exec(claude, ["--version"])).stdout.trim()).toBe("2.1.237 (Claude Code)");
  expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  expect(process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION).toBe("us-west-1");
  if (process.env.AWS_REGION !== undefined) expect(process.env.AWS_REGION).toBe("us-west-1");
  if (process.env.AWS_DEFAULT_REGION !== undefined) {
    expect(process.env.AWS_DEFAULT_REGION).toBe("us-west-1");
  }
  expect(model).toBe("global.anthropic.claude-sonnet-4-6");

  const scratch = await mkdtemp(join(tmpdir(), "remote-claw-m4-live-"));
  const secret = join(scratch, "identity");
  const settings = join(scratch, "ask-settings.json");
  await writeFile(settings, JSON.stringify({ permissions: { ask: ["Bash(uname:*)"] } }), {
    mode: 0o600,
  });
  await exec(cli, ["--rc-identity", "--rc-json", "--rc-file", secret]);
  const pass = (await exec(cli, ["--rc-pass", "--rc-quiet", "--rc-file", secret])).stdout.trim();

  const inFlight = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const proxy = createServer((req, res) => void forward(req, res, baseURL, inFlight));
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("proxy did not bind TCP");
  const broker = `http://127.0.0.1:${address.port}`;

  let proxyClosed = false;
  const closeProxy = async (): Promise<void> => {
    if (proxyClosed) return;
    proxyClosed = true;
    const closed = once(proxy, "close");
    proxy.close();
    for (const request of inFlight) request.abort();
    for (const socket of sockets) socket.destroy();
    await closed;
  };

  let stderr = "";
  const hostEnv: NodeJS.ProcessEnv = { ...process.env, RC_CLAUDE_BIN: claude, RC_LOG: "warn" };
  delete hostEnv.RC_LOG_FILE;
  const host = spawn(
    cli,
    [
      "--rc-file",
      secret,
      "--rc-app",
      broker,
      "--rc-backend",
      "sqlite",
      "--rc-driver",
      "tmux",
      "--settings",
      settings,
      "--model",
      model,
    ],
    { cwd, env: hostEnv, stdio: ["ignore", "ignore", "pipe"] },
  );
  host.stderr?.setEncoding("utf8");
  host.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const contexts: BrowserContext[] = [];
  try {
    const attach = await waitFor(() => {
      if (host.exitCode !== null || host.signalCode !== null) {
        throw new Error(`tmux host exited before attach: ${stderr}`);
      }
      return stderr.match(/'tmux' '-S' '([^']+)' 'attach' '-t' '([^']+)'/);
    });
    const socket = attach[1];
    const session = attach[2];
    if (socket === undefined || session === undefined) throw new Error("invalid attach command");
    const runtime = dirname(socket);

    // Directly own the regression: this launch has no remote-claw permission hook, decision artifact,
    // trust mutation, or automatic dangerous flag. An older mirror implementation fails here.
    const merged = JSON.parse(await readFile(join(runtime, "settings.json"), "utf8")) as {
      hooks?: {
        PreToolUse?: unknown;
        SessionStart?: unknown;
        UserPromptSubmit?: unknown;
        Stop?: unknown;
        Notification?: unknown;
        StopFailure?: unknown;
        SessionEnd?: unknown;
      };
    };
    expect(merged.hooks?.SessionStart).toBeDefined();
    expect(merged.hooks?.PreToolUse).toBeUndefined();
    expect(merged.hooks?.UserPromptSubmit).toBeDefined();
    expect(merged.hooks?.Stop).toBeUndefined();
    expect(merged.hooks?.Notification).toBeUndefined();
    expect(merged.hooks?.StopFailure).toBeUndefined();
    expect(merged.hooks?.SessionEnd).toBeDefined();
    expect(await readdir(runtime)).not.toEqual(
      expect.arrayContaining([
        "permission-hook.mjs",
        "permission-requests.ndjson",
        "permission-decisions",
        "permission-remote-active",
      ]),
    );
    expect(await readFile(join(runtime, "launch.sh"), "utf8")).not.toContain(
      "--dangerously-skip-permissions",
    );

    for (let index = 0; index < 2; index++) {
      const context = await browser.newContext({ baseURL });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(`/?backend=sqlite#${encodeURIComponent(pass)}`);
      await page.getByRole("button", { name: "Connect" }).click();
      const row = page.locator("button.row").first();
      await waitFor(async () => {
        if (host.exitCode !== null || host.signalCode !== null) {
          throw new Error(`tmux host exited before browser publication: ${stderr}`);
        }
        return row.isVisible();
      }, 90_000);
      await row.click();
      await expect(
        page.getByText("Confirming permission mode in the local Claude tmux pane."),
      ).toBeVisible();
    }
    const pageA = contexts[0]?.pages()[0];
    const pageB = contexts[1]?.pages()[0];
    if (pageA === undefined || pageB === undefined) throw new Error("browser pages missing");

    const nonce = Date.now().toString(36);
    const ackA = `M4_ACK_A_${nonce}`;
    const ackB = `M4_ACK_B_${nonce}`;
    await pageA.getByRole("textbox", { name: "Message" }).fill(`Reply with exactly ${ackA}`);
    await pageA.getByRole("button", { name: "Send", exact: true }).click();
    for (const page of [pageA, pageB]) {
      await expect(page.locator(".prose.assistant", { hasText: ackA })).toHaveCount(1, {
        timeout: 180_000,
      });
      await expect(
        page.getByText("Permissions and questions stay in the local Claude tmux pane."),
      ).toBeVisible();
    }

    await pageB.getByRole("textbox", { name: "Message" }).fill(`Reply with exactly ${ackB}`);
    await pageB.getByRole("button", { name: "Send", exact: true }).click();
    for (const page of [pageA, pageB]) {
      await expect(page.locator(".prose.assistant", { hasText: ackB })).toHaveCount(1, {
        timeout: 180_000,
      });
    }
    await pageA.reload();
    const reloadedRow = pageA.locator("button.row").first();
    await expect(reloadedRow).toBeVisible({ timeout: 30_000 });
    await reloadedRow.click();
    await expect(pageA.locator(".prose.assistant", { hasText: ackA })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(pageA.locator(".prose.assistant", { hasText: ackB })).toHaveCount(1);

    const markerEvent = JSON.parse(
      (await readFile(join(runtime, "session-events.ndjson"), "utf8")).trim().split("\n").at(-1) ??
        "{}",
    ) as { transcript_path?: unknown };
    if (typeof markerEvent.transcript_path !== "string") {
      throw new Error("native transcript path missing from readiness marker");
    }
    const transcript = markerEvent.transcript_path;
    const hasAssistantText = async (text: string): Promise<boolean> =>
      (await readFile(transcript, "utf8"))
        .split("\n")
        .some((line) => assistantText(line).includes(text));
    const capture = async (): Promise<string> =>
      (await exec("tmux", ["-S", socket, "capture-pane", "-p", "-S", "-", "-t", session])).stdout;
    const sendLocal = async (prompt: string): Promise<void> => {
      await exec("tmux", ["-S", socket, "send-keys", "-t", session, "-l", prompt]);
      await exec("tmux", ["-S", socket, "send-keys", "-t", session, "Enter"]);
    };

    // Put a real native permission modal in focus, then publish a browser prompt. The active-turn gate
    // must leave that prompt queued: its paste+Enter may not approve or touch the focused modal.
    const localPermissionMarker = `M4_LOCAL_PERMISSION_${nonce}_DONE`;
    await sendLocal(
      `Use Bash to run uname -s. Then reply with exactly the concatenation of ` +
        `"M4_LOCAL_PERMISSION_${nonce}_" and "DONE".`,
    );
    await waitFor(async () => {
      const pane = await capture();
      return pane.includes("Do you want to proceed?") || pane.includes("Yes, and don't ask again");
    });
    const queuedAfterPermission = `M4_QUEUED_AFTER_PERMISSION_${nonce}`;
    await pageB
      .getByRole("textbox", { name: "Message" })
      .fill(`Reply with exactly ${queuedAfterPermission}`);
    await pageB.getByRole("button", { name: "Send", exact: true }).click();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const stillFocused = await capture();
    expect(
      stillFocused.includes("Do you want to proceed?") ||
        stillFocused.includes("Yes, and don't ask again"),
    ).toBe(true);
    expect(await hasAssistantText(localPermissionMarker)).toBe(false);

    // Both browsers now depart while their accepted prompt is queued. Local Claude still owns the
    // decision; resolving it reopens the next native turn and the queued browser text then completes.
    await Promise.all(contexts.map((context) => context.close()));
    await exec("tmux", ["-S", socket, "send-keys", "-t", session, "Enter"]);
    await waitFor(() => hasAssistantText(localPermissionMarker));
    await waitFor(() => hasAssistantText(queuedAfterPermission));

    // Now sever the host's long-lived broker transport and prove a new native/local turn still completes
    // in the retained pane. Closing the proxy and all accepted sockets is the direct broker-loss fact;
    // waiting for a particular retry log line would only test internal timing and wording.
    await closeProxy();
    expect(host.exitCode).toBeNull();
    await exec("tmux", ["-S", socket, "has-session", "-t", session]);
    const afterLossMarker = `M4_AFTER_BROKER_LOSS_${nonce}_DONE`;
    await sendLocal(
      `Reply with exactly the concatenation of "M4_AFTER_BROKER_LOSS_${nonce}_" and "DONE".`,
    );
    await waitFor(() => hasAssistantText(afterLossMarker));
    expect(host.exitCode).toBeNull();
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    await closeProxy().catch(() => {});
    await terminate(host);
    await rm(scratch, { recursive: true, force: true });
  }
});
