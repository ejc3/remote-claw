// Launch-path wiring test: runRcLaunch must stand up the MITM and hand the child claude a proxy env
// that points at it (HTTPS_PROXY) and trusts our CA (NODE_EXTRA_CA_CERTS), then tear it down on exit.
// The session→broker behavior is covered by mitm.test.ts + the apps/web rc-spine e2e; here we pin the
// contract the child relies on. Skips cleanly if openssl is unavailable.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it } from "vitest";
import { runRcLaunch } from "./launch.js";

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const RUN = haveOpenssl();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rc-launch-"));
  dirs.push(d);
  return d;
}

/** True if a TCP connect to 127.0.0.1:port succeeds (the proxy is listening). */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect(port, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

describe.skipIf(!RUN)("runRcLaunch wiring", () => {
  it("spawns claude with HTTPS_PROXY → a live MITM + NODE_EXTRA_CA_CERTS → our CA, then tears down", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(70));
    const certsDir = tmp();

    let seenEnv: NodeJS.ProcessEnv | null = null;
    let proxyPortDuringSpawn = -1;
    let openDuringSpawn = false;

    const code = await runRcLaunch({
      claudeArgs: ["--model", "opus", "chat"],
      identity: id,
      brokerUrl: "http://broker.example",
      certsDir,
      spawnClaude: async (bin, args, env) => {
        seenEnv = env;
        expect(bin).toBe("claude");
        expect(args).toEqual(["--model", "opus", "chat"]);
        // The proxy URL the child will route HTTPS through, and the proxy must be LIVE right now.
        const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
        proxyPortDuringSpawn = m ? Number.parseInt(m[1] as string, 10) : -1;
        openDuringSpawn = proxyPortDuringSpawn > 0 && (await portOpen(proxyPortDuringSpawn));
        return 7; // claude's exit code propagates
      },
    });

    expect(code).toBe(7);
    expect(seenEnv).not.toBeNull();
    const env = seenEnv as unknown as NodeJS.ProcessEnv;
    // Both proxy env forms set (some stacks read the lowercase one).
    expect(env.HTTPS_PROXY).toBe(env.https_proxy);
    // CA points at a real file under our certs dir (the child trusts our leaf via it).
    expect(env.NODE_EXTRA_CA_CERTS).toBe(join(certsDir, "ca.pem"));
    expect(existsSync(env.NODE_EXTRA_CA_CERTS as string)).toBe(true);
    // The MITM was listening during the child's lifetime…
    expect(openDuringSpawn).toBe(true);
    // …and is torn down once the child exits.
    expect(await portOpen(proxyPortDuringSpawn)).toBe(false);
  }, 20_000);

  it("scrubs host-only secrets from the child env (Sec-env) but keeps the proxy env", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(71));
    const certsDir = tmp();
    const prevSecret = process.env.REMOTE_CLAW_SECRET_FILE;
    const prevBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    process.env.REMOTE_CLAW_SECRET_FILE = "/home/u/.local/state/remote-claw/secret";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-should-not-reach-child";
    let seenEnv: NodeJS.ProcessEnv | null = null;
    try {
      await runRcLaunch({
        claudeArgs: [],
        identity: id,
        brokerUrl: "http://broker.example",
        certsDir,
        spawnClaude: async (_bin, _args, env) => {
          seenEnv = env;
          return 0;
        },
      });
    } finally {
      if (prevSecret === undefined) delete process.env.REMOTE_CLAW_SECRET_FILE;
      else process.env.REMOTE_CLAW_SECRET_FILE = prevSecret;
      if (prevBypass === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = prevBypass;
    }
    const env = seenEnv as unknown as NodeJS.ProcessEnv;
    // The host-only secrets are gone from what the child claude sees…
    expect(env.REMOTE_CLAW_SECRET_FILE).toBeUndefined();
    expect(env.VERCEL_AUTOMATION_BYPASS_SECRET).toBeUndefined();
    // …but the proxy env the child genuinely needs survives.
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 20_000);
});
