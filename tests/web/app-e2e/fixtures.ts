// Playwright fixture that stands up the e2e HOST as a real, persistent process (tsx host-runner.ts),
// pointed at the broker the browser uses (use.baseURL — the local webServer or the deployed preview).
// `seedHost(opts)` spawns one host, waits for it to publish the scripted turn + report its viewer pass,
// and returns { pass }. All hosts a test spawns are SIGTERM'd on teardown. The host runs the right way —
// a persistent process that PUBLISHES the seeded turn AND ECHOES the browser's live prompts — so the
// preview e2e is reliable AND full-featured. (This replaced the old /api/dev/seed serverless route,
// whose serve()-under-after() publish could freeze before landing; that route has now been removed.)
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "host-runner.ts");
const TSX = join(HERE, "..", "node_modules", ".bin", "tsx"); // tests/web's own tsx

export interface SeedResult {
  pass: string;
  sessionId: string;
}
export type SeedHost = (opts?: { perm?: boolean; askq?: boolean }) => Promise<SeedResult>;

/** Spawn one host-runner and resolve once it prints its `{pass,sessionId}` readiness line (or reject if it
 *  exits / times out first). Returns the result AND the child so the fixture can kill it on teardown. */
function spawnHost(opts: {
  baseURL: string;
  backend: string | undefined;
  bypass: string | undefined;
  perm?: boolean;
  askq?: boolean;
}): { child: ChildProcess; ready: Promise<SeedResult> } {
  const child = spawn(TSX, [RUNNER], {
    stdio: ["ignore", "pipe", "inherit"], // stdout = the readiness line; stderr inherited for host logs
    env: {
      ...process.env,
      RC_E2E_BASE: opts.baseURL,
      RC_E2E_BACKEND: opts.backend ?? "",
      RC_E2E_BYPASS: opts.bypass ?? "",
      RC_E2E_PERM: opts.perm ? "1" : "",
      RC_E2E_ASKQ: opts.askq ? "1" : "",
    },
  });
  const ready = new Promise<SeedResult>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    // Tear down ALL listeners + the timer on EVERY settle path (resolve/timeout/exit/error) so a failed or
    // timed-out seed never leaks a readline/child listener (Playwright retries → many spawns). After
    // settling we resume stdout so the long-lived child can never backpressure on an unread pipe.
    const cleanup = () => {
      clearTimeout(timer);
      rl.removeAllListeners();
      rl.close();
      child.stdout?.resume();
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("host-runner did not report ready within 60s"));
    }, 60_000);
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`host-runner exited (code ${code}) before reporting ready`));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    rl.on("line", (line) => {
      try {
        const o = JSON.parse(line) as Partial<SeedResult>;
        if (typeof o.pass === "string" && typeof o.sessionId === "string") {
          cleanup();
          resolve({ pass: o.pass, sessionId: o.sessionId });
        }
      } catch {
        // not the readiness line — ignore (the host shouldn't emit other stdout, but be tolerant)
      }
    });
    child.on("exit", onExit);
    child.on("error", onError);
  });
  return { child, ready };
}

/** SIGTERM a host child and AWAIT its exit (bounded), escalating to SIGKILL — so teardown never leaves an
 *  orphaned tsx host process behind (the host-runner also self-force-exits 2s after SIGTERM). Resolves on
 *  the kill timer too (not just on 'exit'), and re-checks for an already-exited child AFTER attaching the
 *  listener, so a child that exits in the tiny gap before once('exit') is wired can never wedge teardown. */
function terminate(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(kill);
      resolve();
    };
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      finish(); // never hang teardown: resolve even if the dead pid emits no 'exit' (OS reaps it)
    }, 3000);
    child.once("exit", finish);
    child.kill("SIGTERM");
    // The child may have exited between the guard above and once('exit') being attached — 'exit' won't
    // re-fire, so re-check and resolve now rather than waiting out the 3s kill timer.
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

export const test = base.extend<{ seedHost: SeedHost }>({
  seedHost: async ({ baseURL }, use) => {
    const children: ChildProcess[] = [];
    const seed: SeedHost = async (opts) => {
      const { child, ready } = spawnHost({
        baseURL: baseURL ?? "",
        backend: process.env.E2E_BACKEND,
        bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        ...(opts ?? {}),
      });
      children.push(child);
      try {
        return await ready;
      } catch (e) {
        await terminate(child); // a failed seed must not leave its host running
        throw e;
      }
    };
    await use(seed);
    await Promise.all(children.map(terminate)); // await every host's exit, escalating to SIGKILL
  },
});

export { expect } from "@playwright/test";
