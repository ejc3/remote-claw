// One opt-in cross-process outcome: packed companion restart and broker-loss isolation on exact
// Codex 0.151.0/Linux arm64, explicit loopback WS + paginated thread, local TUI and two real browsers.
// Deterministic driver tests own reconciliation details; they cannot prove installed/native/browser
// wiring or local TUI survival. The observer below only initializes and reads the supplied thread.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

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
  const nativeURL = new URL(required("URL"));
  const threadId = required("THREAD");
  const cwd = required("CWD");
  const tmuxSocket = required("TMUX_SOCKET");
  const tmuxTarget = required("TMUX_TARGET");
  expect(isAbsolute(cli)).toBe(true);
  expect(`${process.platform}-${process.arch}`).toBe("linux-arm64");
  expect(nativeURL.protocol).toBe("ws:");
  expect(["127.0.0.1", "[::1]"]).toContain(nativeURL.hostname);
  expect(nativeURL.port).not.toBe("");
  expect(nativeURL.pathname + nativeURL.search + nativeURL.hash).toBe("/");
  expect(nativeURL.username + nativeURL.password).toBe("");
  expect(threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
  const observer = new WebSocket(nativeURL);
  let requestId = 0;
  const rpc = <T>(method: string, params: object): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++requestId;
      const cleanup = (): void => {
        clearTimeout(timer);
        observer.removeEventListener("message", onMessage);
      };
      const onMessage = (event: MessageEvent): void => {
        const value = JSON.parse(String(event.data)) as { id?: number; result: T; error?: unknown };
        if (value.id !== id) return;
        cleanup();
        if (value.error) reject(new Error(`native read failed: ${method}`));
        else resolve(value.result);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`native read timed out: ${method}`));
      }, 15_000);
      observer.addEventListener("message", onMessage);
      observer.send(JSON.stringify({ id, method, params }));
    });
  const nativeItems = async (): Promise<NativeItem[]> => {
    const items: NativeItem[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: NativeItem[]; nextCursor: string | null } = await rpc(
        "thread/items/list",
        {
          threadId,
          limit: 100,
          sortDirection: "asc",
          ...(cursor ? { cursor } : {}),
        },
      );
      items.push(
        ...page.data.filter(({ item }) => ["userMessage", "agentMessage"].includes(item.type)),
      );
      cursor = page.nextCursor;
      expect(items.length).toBeLessThan(1_000);
    } while (cursor);
    return items;
  };
  const idle = async (): Promise<boolean> => {
    const result = await rpc<{
      thread: { id: string; historyMode: string; status: { type: string } };
    }>("thread/read", { threadId, includeTurns: false });
    expect(result.thread.id).toBe(threadId);
    expect(result.thread.historyMode).toBe("paginated");
    return result.thread.status.type === "idle";
  };
  try {
    await new Promise<void>((resolve, reject) => {
      observer.addEventListener("open", () => resolve(), { once: true });
      observer.addEventListener(
        "error",
        () => reject(new Error("native observer could not connect")),
        { once: true },
      );
    });
    const initialized = await rpc<{ userAgent: string; platformOs: string }>("initialize", {
      clientInfo: { name: "remote-claw-recovery-observer", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    expect(initialized.userAgent.split(" ")[0]).toMatch(/\/0\.151\.0$/);
    expect(initialized.platformOs).toBe("linux");
    observer.send(JSON.stringify({ method: "initialized" }));
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
          nativeURL.href,
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
    observer.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
