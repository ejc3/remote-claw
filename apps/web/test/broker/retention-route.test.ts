import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETENTION_MS,
  retentionMs,
  tursoConfigured,
} from "../../app/api/cron/retention/gate";
import { GET } from "../../app/api/cron/retention/route";

const mocks = vi.hoisted(() => ({
  getBackend: vi.fn(),
}));

vi.mock("../../lib/broker", () => ({
  getBackend: mocks.getBackend,
}));

const env = process.env as Record<string, string | undefined>;
const KEYS = [
  "BROKER_BACKEND",
  "BROKER_RETENTION_MS",
  "CRON_SECRET",
  "NODE_ENV",
  "TURSO_DATABASE_URL",
  "VERCEL",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = env[k];
    delete env[k];
  }
  mocks.getBackend.mockReset();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function req(auth?: string): Request {
  const headers = auth === undefined ? undefined : { authorization: auth };
  return new Request("https://x.test/api/cron/retention", headers ? { headers } : undefined);
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe("retentionMs", () => {
  it("requires a strictly positive integer millisecond value", () => {
    env.BROKER_RETENTION_MS = "0";
    expect(retentionMs()).toBe(DEFAULT_RETENTION_MS);
    env.BROKER_RETENTION_MS = "7d";
    expect(retentionMs()).toBe(DEFAULT_RETENTION_MS);
    env.BROKER_RETENTION_MS = "120000";
    expect(retentionMs()).toBe(120_000);
  });

  it("falls back for non-canonical values and trims valid decimal integers", () => {
    for (const raw of ["-1", "", "  ", "1.5", "1e3", "0x10", "+5", "9007199254740993"]) {
      env.BROKER_RETENTION_MS = raw;
      expect(retentionMs(), raw).toBe(DEFAULT_RETENTION_MS);
    }
    for (const [raw, expected] of [
      [" 500 ", 500],
      ["00500", 500],
    ] as const) {
      env.BROKER_RETENTION_MS = raw;
      expect(retentionMs(), raw).toBe(expected);
    }
  });

  it("treats a configured Turso URL as this deployment's requestable Turso store", () => {
    expect(tursoConfigured()).toBe(false);
    env.BROKER_BACKEND = "vercel";
    expect(tursoConfigured()).toBe(false);
    env.TURSO_DATABASE_URL = " file:test.db ";
    expect(tursoConfigured()).toBe(true);
  });
});

describe("retention cron route", () => {
  it("uses the shared auth gate and returns 404 when unauthorized", async () => {
    env.CRON_SECRET = "cron";
    env.TURSO_DATABASE_URL = "file:test.db";

    const res = await GET(req("Bearer wrong"));

    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not found" });
    expect(mocks.getBackend).not.toHaveBeenCalled();
  });

  it("falls back to swept:0 when Turso is not configured", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "turso";

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 0 });
    expect(mocks.getBackend).not.toHaveBeenCalled();
  });

  it("runs sweep when Turso is configured even if Vercel is the default backend", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "vercel";
    env.TURSO_DATABASE_URL = "file:test.db";
    const sweep = vi.fn().mockResolvedValue(2);
    mocks.getBackend.mockResolvedValue({ sweep });

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 2 });
    expect(mocks.getBackend).toHaveBeenCalledWith("turso");
    expect(sweep).toHaveBeenCalledWith(DEFAULT_RETENTION_MS);
  });

  it("falls back to swept:0 when the backend has no sweep hook", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "turso";
    env.TURSO_DATABASE_URL = "file:test.db";
    mocks.getBackend.mockResolvedValue({});

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 0 });
  });

  it("runs sweep with a valid retention override", async () => {
    env.BROKER_RETENTION_MS = "45000";
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "turso";
    env.TURSO_DATABASE_URL = "file:test.db";
    const sweep = vi.fn().mockResolvedValue(3);
    mocks.getBackend.mockResolvedValue({ sweep });

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ swept: 3 });
    expect(mocks.getBackend).toHaveBeenCalledWith("turso");
    expect(sweep).toHaveBeenCalledWith(45_000);
  });

  it("returns 500 when backend construction or sweep fails", async () => {
    env.CRON_SECRET = "cron";
    env.BROKER_BACKEND = "turso";
    env.TURSO_DATABASE_URL = "file:test.db";
    mocks.getBackend.mockRejectedValue(new Error("bad turso"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await GET(req("Bearer cron"));

    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "bad turso" });
    expect(error).toHaveBeenCalledWith("[turso-retention] sweep failed:", "bad turso");
  });
});
