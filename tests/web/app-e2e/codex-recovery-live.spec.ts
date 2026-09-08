// One opt-in cross-process outcome: packed companion restart and broker-loss isolation on supported
// Codex/Linux arm64, managed Unix or explicit loopback WS, local TUI and two real browsers.
// Deterministic driver tests own reconciliation details; they cannot prove installed/native/browser
// wiring or local TUI survival. The observer only joins/reads the supplied thread; it never answers
// native requests or mutates native work. This test does not exercise the official Remote client.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  assertCodexCompatibility,
  CodexAppServerClient,
  codexAppServerVersion,
  isCodexThreadId,
  normalizeCodexAppServerUrl,
} from "../../../packages/cli/src/host/rc/codex/client.js";

const exec = promisify(execFile);
const required = (name: string): string => {
  const value = process.env[`RC_CODEX_RECOVERY_${name}`];
  if (!value) throw new Error(`RC_CODEX_RECOVERY_${name} is required`);
  return value;
};

async function waitFor<T>(probe: () => T | Promise<T>, timeout = 180_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  do {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error("timed out waiting for the Codex recovery outcome");
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

type NativeItem = { turnId: string; item: { type: string; text?: string; content?: unknown[] } };

test("Codex: fresh projection after companion restart; native TUI survives broker loss", async ({
  browser,
}) => {
  if (process.env.RC_CODEX_RECOVERY_LIVE !== "1")
    throw new Error("RC_CODEX_RECOVERY_LIVE=1 is required");
  const cli = required("CLI");
  const nativeURL = normalizeCodexAppServerUrl(required("URL"));
  const threadId = required("THREAD");
  const cwd = required("CWD");
  const tmuxSocket = required("TMUX_SOCKET");
  const tmuxTarget = required("TMUX_TARGET");
  expect(isAbsolute(cli)).toBe(true);
  expect(`${process.platform}-${process.arch}`).toBe("linux-arm64");
  expect(isCodexThreadId(threadId)).toBe(true);
  const tmux = async (...args: string[]): Promise<string> =>
    (await exec("tmux", ["-S", tmuxSocket, ...args])).stdout;
  const capture = (): Promise<string> => tmux("capture-pane", "-p", "-S", "-", "-t", tmuxTarget);
  await tmux("has-session", "-t", tmuxTarget);

  const scratch = await mkdtemp(join(tmpdir(), "remote-claw-codex-recovery-"));
  await chmod(scratch, 0o700);
  const identity = join(scratch, "identity");
  const contexts: BrowserContext[] = [];
  const children: ChildProcess[] = [];
  const sockets = new Set<Socket>();
  const proxy = createServer((downstream) => {
    const upstream = createConnection({ host: "127.0.0.1", port: 3103 });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {
        downstream.destroy();
        upstream.destroy();
      });
    }
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });
  let proxyClosed = false;
  const closeProxy = async (): Promise<void> => {
    if (proxyClosed || !proxy.listening) return;
    proxyClosed = true;
    const closed = once(proxy, "close");
    proxy.close();
    await Promise.all([
      closed,
      ...[...sockets].map(async (socket) => {
        const socketClosed = once(socket, "close");
        socket.destroy();
        await socketClosed;
      }),
    ]);
  };
  const observer = new CodexAppServerClient(nativeURL);
  const observerAbort = new AbortController();
  const signal = observerAbort.signal;
  try {
    const initialized = await observer.initialize(signal);
    assertCodexCompatibility(initialized);
    const resumed = await observer.resume(threadId, signal);
    expect(resumed.thread.id).toBe(threadId);
    expect(resumed.thread.canAcceptDirectInput).toBe(true);
    expect(["active", "idle"]).toContain(resumed.thread.status.type);
    const historyMode = resumed.thread.historyMode;
    await test.info().attach("codex-native-tuple", {
      body: JSON.stringify({
        version: codexAppServerVersion(initialized.userAgent),
        platform: `${process.platform}-${process.arch}`,
        transport: nativeURL === "unix://" ? "managed-unix" : "loopback-ws",
        historyMode,
      }),
      contentType: "application/json",
    });
    const nativeItems = async (): Promise<NativeItem[]> => {
      const items: NativeItem[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let pageNo = 0; pageNo < 1_000; pageNo += 1) {
        const page =
          historyMode === "legacy"
            ? await observer.listTurnItems(threadId, cursor, signal)
            : await observer.listItems(threadId, cursor, signal);
        items.push(
          ...page.data.filter(({ item }) => ["userMessage", "agentMessage"].includes(item.type)),
        );
        observer.drainInbound();
        expect(items.length).toBeLessThan(1_000);
        if (page.nextCursor === null) return items;
        expect(page.nextCursor).not.toBe("");
        expect(seen.has(page.nextCursor)).toBe(false);
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new Error("dedicated Codex recovery thread exceeded the history page limit");
    };
    const idle = async (): Promise<boolean> => {
      const turnId = await observer.activeTurn(threadId, signal);
      observer.drainInbound();
      return turnId === null;
    };
    await waitFor(idle);
    await exec(cli, ["--rc-identity", "--rc-json", "--rc-file", identity]);
    const pass = (
      await exec(cli, ["--rc-pass", "--rc-quiet", "--rc-file", identity])
    ).stdout.trim();
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("broker proxy did not bind");
    const broker = `http://127.0.0.1:${address.port}`;
    const launch = (): ChildProcess => {
      const env: NodeJS.ProcessEnv = { ...process.env, RC_LOG: "warn" };
      delete env.RC_LOG_FILE;
      const child = spawn(
        cli,
        [
          "--rc-file",
          identity,
          "--rc-app",
          broker,
          "--rc-backend",
          "sqlite",
          "--rc-driver",
          "codex",
          "--rc-codex-url",
          nativeURL,
          "--rc-codex-thread",
          threadId,
        ],
        { cwd, env, stdio: "ignore" },
      );
      children.push(child);
      return child;
    };
    let host = launch();
    const sessions = new Map<Page, Set<string>>();
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ baseURL: broker, viewport });
      contexts.push(context);
      const page = await context.newPage();
      const seen = new Set<string>();
      sessions.set(page, seen);
      page.on("request", (request) => {
        const url = new URL(request.url());
        const id = url.searchParams.get("session");
        if (url.pathname === "/api/stream" && id) seen.add(id);
      });
      await page.goto("/?backend=sqlite");
      await expect(page.getByLabel("Machine pass", { exact: true })).toBeVisible();
      // Exercise the real pairing-fragment flow without putting the pass in a logged goto URL.
      await page.evaluate((value) => {
        window.location.hash = value;
      }, pass);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
    }
    const pages = contexts.map((context) => context.pages()[0] as Page);
    const select = async (): Promise<string> => {
      for (const page of pages) {
        await expect(page.locator("button.row")).toHaveCount(1);
        await page.locator("button.row").click();
        await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
      }
      const ids = await Promise.all(
        pages.map((page) => waitFor(() => [...(sessions.get(page) ?? [])].at(-1))),
      );
      expect(new Set(ids).size).toBe(1);
      return ids[0] as string;
    };
    const expectTurn = async (marker: string): Promise<void> => {
      for (const page of pages) {
        await expect(page.locator(".prose.assistant", { hasText: marker })).toHaveCount(1, {
          timeout: 180_000,
        });
        await expect(
          page.locator(".row-user", { hasText: `Reply with exactly ${marker}` }),
        ).toHaveCount(1);
      }
      await waitFor(idle);
    };
    const send = async (page: Page, marker: string): Promise<void> => {
      await page.getByRole("textbox", { name: "Message" }).fill(`Reply with exactly ${marker}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expectTurn(marker);
    };
    const firstProjection = await select();
    const nonce = Date.now().toString(36);
    const ackA = `CODEX_RECOVERY_A_${nonce}`;
    const ackB = `CODEX_RECOVERY_B_${nonce}`;
    await send(pages[0] as Page, ackA);
    const before = await nativeItems();
    await terminate(host);
    expect(host.exitCode).toBe(0);
    for (const page of pages) await expect(page.locator("button.row")).toHaveCount(0);
    await tmux("has-session", "-t", tmuxTarget);
    host = launch();
    for (const seen of sessions.values()) seen.clear();
    expect(await select()).not.toBe(firstProjection);
    await expectTurn(ackA);
    expect(await nativeItems()).toEqual(before);
    await send(pages[1] as Page, ackB);
    await expectTurn(ackA);
    const canonical = await nativeItems();
    expect(canonical.slice(0, before.length)).toEqual(before);
    for (const marker of [ackA, ackB]) {
      expect(
        canonical.filter(({ item }) => item.type === "agentMessage" && item.text === marker),
      ).toHaveLength(1);
      expect(
        canonical.filter(
          ({ item }) =>
            item.type === "userMessage" && JSON.stringify(item.content).includes(marker),
        ),
      ).toHaveLength(1);
    }
    const artifacts = process.env.RC_CODEX_RECOVERY_ARTIFACTS;
    if (artifacts) {
      expect(isAbsolute(artifacts)).toBe(true);
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      for (const [index, page] of pages.entries())
        await page.screenshot({
          path: join(artifacts, `browser-${index + 1}.png`),
          fullPage: true,
        });
    }
    expect(host.exitCode).toBeNull();
    await closeProxy();
    expect(proxy.listening).toBe(false);
    expect(sockets.size).toBe(0);
    const localMarker = `CODEX_RECOVERY_LOCAL_${nonce}_DONE`;
    await tmux(
      "send-keys",
      "-t",
      tmuxTarget,
      "-l",
      `Reply with exactly the concatenation of "CODEX_RECOVERY_LOCAL_${nonce}_" and "DONE".`,
    );
    // tmux acknowledgement precedes Codex consuming the input burst. An immediate Enter left the
    // entire prompt in the native editor in the live run; wait for that editor, then settle the burst.
    await waitFor(async () => (await capture()).includes(`CODEX_RECOVERY_LOCAL_${nonce}_`), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await tmux("send-keys", "-t", tmuxTarget, "Enter");
    await waitFor(async () => (await capture()).includes(localMarker));
    await waitFor(idle);
    expect(
      (await nativeItems()).filter(
        ({ item }) => item.type === "agentMessage" && item.text === localMarker,
      ),
    ).toHaveLength(1);
    await waitFor(() => host.exitCode !== null || host.signalCode !== null);
    expect(host.exitCode).toBe(1);
    expect(host.signalCode).toBeNull();
    await tmux("has-session", "-t", tmuxTarget);
    expect(await idle()).toBe(true);
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    await Promise.all(children.map((child) => terminate(child).catch(() => {})));
    await closeProxy().catch(() => {});
    observerAbort.abort();
    observer.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
