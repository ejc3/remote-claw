import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handoffConfigured } from "../../lib/broker/handoff-store";
import { FileDbLocator } from "../../lib/broker/sqlite-multi";

// handoffConfigured() must FAIL CLOSED on Vercel: a file: handoff store is per-instance, so a PUT and its
// claim would land on different serverless instances and never match. handoffConfig() hard-fails on Vercel
// EVEN when RC_SQLITE_DIR is set — that env only acknowledges an ephemeral per-SESSION store; the one-time
// handoff specifically requires a shared cloud (Turso) db. Off-Vercel, a local file: store is fine. The
// route relies on this: handoffConfigured() false → the endpoint reports unavailable instead of silently
// storing a blob no claim can ever recover.
const KEYS = [
  "VERCEL",
  "RC_SQLITE_DIR",
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_GROUP_AUTH_TOKEN",
] as const;
const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = env[k];
    delete env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "rc-handoff-cfg-"));
  // Acknowledge an ephemeral per-session location — this satisfies the FileDbLocator CONSTRUCTOR guard so
  // the tests isolate the handoff-SPECIFIC fail-closed in handoffConfig(), not the per-session one.
  env.RC_SQLITE_DIR = dir;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("handoffConfigured() fail-closed", () => {
  it("is TRUE off-Vercel with a local file: store", () => {
    expect(handoffConfigured()).toBe(true);
  });

  it("is FALSE on Vercel without Turso Cloud creds — even with RC_SQLITE_DIR set", () => {
    env.VERCEL = "1";
    expect(handoffConfigured()).toBe(false);
  });

  it("FileDbLocator.handoffConfig() hard-fails on Vercel even when RC_SQLITE_DIR is set", () => {
    env.VERCEL = "1";
    expect(() => new FileDbLocator(dir).handoffConfig()).toThrow(
      /one-time-handoff store needs a cloud/i,
    );
  });

  it("FileDbLocator.handoffConfig() resolves to a local _handoff.db off-Vercel", () => {
    expect(new FileDbLocator(dir).handoffConfig().url).toBe(`file:${join(dir, "_handoff.db")}`);
  });
});
